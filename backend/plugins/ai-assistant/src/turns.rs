//! 线程归属锁覆盖一轮CLI实际退出，未确认轮次不自动重放。
use crate::{config::Config, model, sessions::Lease};
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{InvocationContext, Output};
use deviceforge_tool_process::{Environment, ExecutionOptions, ToolCommand, capture};
use serde_json::{Value, json};
use std::path::PathBuf;

async fn acquire(
    root: PathBuf,
    id: String,
    project: String,
    directory: PathBuf,
    context: InvocationContext,
) -> Result<Lease, String> {
    tokio::task::spawn_blocking(move || {
        Lease::acquire(&root, &id, &project, &directory, &|| {
            context.check().map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|_| "AI会话工作异常".to_owned())?
}

pub(crate) async fn execute(
    request: Request,
    config: Config,
    context: &InvocationContext,
    cleanup: &mut CleanupOutcome,
) -> Result<Output, String> {
    let management = ["session.get", "session.close"].contains(&request.operation.as_str());
    if !management && !["cli.single", "cli.turn"].contains(&request.operation.as_str()) {
        return Err("未知AI助手操作".into());
    }
    let mut input = request.input;
    if request.operation == "cli.single" && input.get("thread_id").is_some() {
        return Err("单次请求不得携带已有线程".into());
    }
    if management {
        if input.get("prompt").is_some() {
            return Err("AI会话管理不接受提示词".into());
        }
        input
            .as_object_mut()
            .ok_or("AI会话管理输入无效")?
            .insert("prompt".into(), Value::String("会话管理".into()));
    }
    let turn = model::parse(input)?;
    if request.operation == "cli.single" && turn.thread_id.is_some() {
        return Err("单次请求不得携带已有线程".into());
    }
    let configured = config
        .projects
        .get(&turn.project_id)
        .ok_or("未配置该项目")?;
    let project = tokio::fs::canonicalize(configured)
        .await
        .map_err(|_| "配置的项目不存在")?;
    if !tokio::fs::metadata(&project)
        .await
        .is_ok_and(|meta| meta.is_dir())
    {
        return Err("配置的项目不是目录".into());
    }
    let mut lease = if let Some(id) = &turn.thread_id {
        Some(
            acquire(
                config.state_root.clone(),
                id.clone(),
                turn.project_id.clone(),
                project.clone(),
                context.clone(),
            )
            .await?,
        )
    } else {
        None
    };
    if management {
        let mut state = lease.take().ok_or("AI会话管理需要线程标识")?;
        let local = context.clone();
        let close = request.operation == "session.close";
        return tokio::task::spawn_blocking(move || {
            if close {state.close(&|| local.check().map_err(|error| error.to_string()))?;}
            let snapshot = state.snapshot.as_ref().ok_or("AI线程不存在")?;
            Ok(Output::from(json!({"project_id":snapshot.project_id,"thread_id":snapshot.thread_id,"turns":snapshot.turns.to_string(),"closed":snapshot.closed,"uncertain":snapshot.uncertain})))
        }).await.map_err(|_| "AI会话管理工作异常".to_owned())?;
    }
    if let Some(mut state) = lease.take() {
        let local = context.clone();
        lease = Some(
            tokio::task::spawn_blocking(move || {
                state.begin(&|| local.check().map_err(|error| error.to_string()))?;
                Ok::<_, String>(state)
            })
            .await
            .map_err(|_| "AI会话串行工作异常".to_owned())??,
        );
    }
    run(config, turn, project, lease, context, cleanup).await
}

async fn run(
    config: Config,
    turn: model::Turn,
    project: PathBuf,
    lease: Option<Lease>,
    context: &InvocationContext,
    cleanup: &mut CleanupOutcome,
) -> Result<Output, String> {
    let mut args = if let Some(thread) = &turn.thread_id {
        vec![
            "exec".into(),
            "resume".into(),
            "--json".into(),
            thread.to_ascii_lowercase(),
        ]
    } else {
        vec!["exec".into(), "--json".into()]
    };
    args.extend(config.args);
    args.push("-".into());
    let mut command = ToolCommand::new(&config.executable, &args);
    command.input = Some(turn.prompt.as_bytes());
    command.directory = Some(&project);
    command.environment = Environment::Restricted;
    for (name, value) in config.environment {
        command.env.insert(name.into(), value.into());
    }
    let mut options = ExecutionOptions::new(context.deadline().into());
    options.stdout_limit = 4 * 1024 * 1024;
    options.stderr_limit = 1024 * 1024;
    let output = match capture(command, options, context.cancellation()).await {
        Ok(output) => output,
        Err(error) => {
            if matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. }) {
                *cleanup = CleanupOutcome::Failed;
            }
            return Err("AI助手CLI执行失败，诊断未包含凭据或原始工具输出".into());
        }
    };
    context.check().map_err(|error| error.to_string())?;
    let mut value = model::response(&output.stdout)?;
    let id = value
        .get("thread_id")
        .and_then(Value::as_str)
        .or(turn.thread_id.as_deref())
        .ok_or("AI助手未返回可恢复线程标识")?
        .to_ascii_lowercase();
    if !model::valid_thread(&id)
        || turn
            .thread_id
            .as_deref()
            .is_some_and(|previous| !previous.eq_ignore_ascii_case(&id))
    {
        return Err("AI助手返回线程与请求不匹配".into());
    }
    value["thread_id"] = json!(id);
    value["project_id"] = json!(turn.project_id);
    // 在确认持久轮次前检查协议结果大小，避免记录了完成却无法交付回答。
    if serde_json::to_vec(&value)
        .map_err(|_| "AI助手结果序列化失败")?
        .len()
        > 1024 * 1024 - 4096
    {
        return Err("AI助手结果超过公开协议帧限额".into());
    }
    let mut state = match lease {
        Some(state) => state,
        None => {
            let state = acquire(
                config.state_root,
                id.clone(),
                turn.project_id.clone(),
                project.clone(),
                context.clone(),
            )
            .await?;
            if state.snapshot.is_some() {
                return Err("AI助手返回已经登记的线程，拒绝覆盖归属".into());
            }
            state
        }
    };
    let project_id = turn.project_id.clone();
    let saved_id = id.clone();
    let local = context.clone();
    tokio::task::spawn_blocking(move || {
        state.complete(project_id, project, saved_id, &|| {
            local.check().map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|_| "AI会话提交工作异常".to_owned())??;
    Ok(Output::from(value))
}
