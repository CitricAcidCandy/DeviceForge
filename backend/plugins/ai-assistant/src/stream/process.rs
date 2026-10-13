use super::{
    events::Events,
    output::Writer,
    state::{self, Resources},
};
use crate::{config::Config, model::Turn};
use deviceforge_plugin_runtime::{
    InvocationContext, Output,
    session::{SessionInput, SessionOutput},
};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, StreamOptions, ToolCommand,
    spawn_stream_with_lease,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::time;

struct Owner {
    root: PathBuf,
    project: PathBuf,
    project_id: String,
}

async fn reject_input(mut input: SessionInput) -> Result<(), String> {
    match input.recv().await.map_err(|_| "AI会话输入已中断")? {
        Some(_) => Err("AI流会话提示词已在Open提交，不接受追加Input".into()),
        None => Ok(()),
    }
}

async fn deliver(
    events: Vec<Value>,
    parser: &Events,
    owner: &Owner,
    context: &InvocationContext,
    resources: &Arc<Resources>,
    registered: &mut bool,
    writer: &mut Writer,
) -> Result<(), String> {
    if !*registered && let Some(id) = parser.thread() {
        state::acquire(
            resources,
            owner.root.clone(),
            id.to_owned(),
            owner.project_id.clone(),
            owner.project.clone(),
            false,
            context,
        )
        .await?;
        *registered = true;
    }
    for event in events {
        context.check().map_err(|error| error.to_string())?;
        writer.send(&event).await?;
    }
    Ok(())
}

fn arguments(config: &Config, turn: &Turn) -> Vec<String> {
    let mut arguments = if let Some(id) = &turn.thread_id {
        vec![
            "exec".into(),
            "resume".into(),
            "--json".into(),
            id.to_ascii_lowercase(),
        ]
    } else {
        vec!["exec".into(), "--json".into()]
    };
    arguments.extend(config.args.iter().cloned());
    arguments.push("-".into());
    arguments
}

pub(crate) async fn run(
    config: Config,
    turn: Turn,
    context: InvocationContext,
    resources: Arc<Resources>,
    input: SessionInput,
    output: SessionOutput,
) -> Result<Output, String> {
    let configured = config
        .projects
        .get(&turn.project_id)
        .ok_or("未配置该项目")?;
    let project = tokio::fs::canonicalize(configured)
        .await
        .map_err(|_| "配置的项目不存在")?;
    if !tokio::fs::metadata(&project)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err("配置的项目不是目录".into());
    }
    let owner = Owner {
        root: config.state_root.clone(),
        project,
        project_id: turn.project_id.clone(),
    };
    let mut parser = Events::new(turn.thread_id.clone(), &config.environment)?;
    let mut registered = turn.thread_id.is_some();
    if let Some(id) = &turn.thread_id {
        state::acquire(
            &resources,
            owner.root.clone(),
            id.clone(),
            owner.project_id.clone(),
            owner.project.clone(),
            true,
            &context,
        )
        .await?;
    }
    context.check().map_err(|error| error.to_string())?;
    let arguments = arguments(&config, &turn);
    let mut command = ToolCommand::new(&config.executable, &arguments);
    command.directory = Some(&owner.project);
    command.environment = Environment::Restricted;
    for (name, value) in &config.environment {
        command.env.insert(name.into(), value.into());
    }
    let mut execution = ExecutionOptions::new(context.deadline().into());
    execution.stdout_limit = 4 * 1024 * 1024;
    execution.stderr_limit = 1024 * 1024;
    let mut options = StreamOptions::new(execution);
    options.input_limit = 512 * 1024;
    let mut process =
        spawn_stream_with_lease(command, options, context.cancellation(), resources.clone())
            .await
            .map_err(|error| {
                if matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. }) {
                    resources.fail_cleanup();
                }
                "AI实时工具启动失败，诊断已隐藏".to_owned()
            })?;
    let tool_input = process.input();
    let send_prompt = async {
        for chunk in turn.prompt.as_bytes().chunks(8192) {
            tool_input
                .send(chunk)
                .await
                .map_err(|_| "AI提示词提交失败")?;
        }
        tool_input.close().await.map_err(|_| "AI工具输入结束失败")
    };
    let check_input = reject_input(input);
    tokio::pin!(send_prompt, check_input);
    let mut prompt_sent = false;
    let mut input_closed = false;
    let mut writer = Writer::new(output);
    let cancel = context.cancellation();
    let cause = loop {
        tokio::select! {
            biased;
            _ = time::sleep_until(context.deadline().into()) => break Some("AI实时轮次超过原期限".to_owned()),
            _ = cancel.cancelled() => break Some("AI实时轮次已取消".to_owned()),
            result = &mut send_prompt, if !prompt_sent => {
                match result {
                    Ok(()) => prompt_sent = true,
                    Err(error) => break Some(error.to_owned()),
                }
            },
            result = &mut check_input, if !input_closed => {
                match result {
                    Ok(()) => input_closed = true,
                    Err(error) => break Some(error),
                }
            },
            chunk = process.recv() => {
                let Some(chunk) = chunk else { break None; };
                if chunk.stream == OutputStream::Stdout {
                    let events = match parser.feed(&chunk.bytes) {
                        Ok(events) => events,
                        Err(error) => break Some(error),
                    };
                    if let Err(error) = deliver(events, &parser, &owner, &context, &resources, &mut registered, &mut writer).await {
                        break Some(error);
                    }
                }
            },
        }
    };
    if cause.is_some() {
        process.cancel();
    }
    let result = process.wait().await;
    if matches!(
        result,
        Err(deviceforge_tool_process::Error::CleanupFailed { .. })
    ) {
        resources.fail_cleanup();
    }
    if let Some(error) = cause {
        return Err(error);
    }
    let exit = result.map_err(|_| "AI实时工具执行失败，诊断已隐藏")?;
    context.check().map_err(|error| error.to_string())?;
    if !prompt_sent || !exit.status.success() {
        return Err("AI提示词未完整提交或工具未成功退出".into());
    }
    let tail = parser.finish()?;
    deliver(
        tail,
        &parser,
        &owner,
        &context,
        &resources,
        &mut registered,
        &mut writer,
    )
    .await?;
    let id = parser.thread().ok_or("AI提供者未返回线程")?.to_owned();
    let mut result = json!({
        "project_id":owner.project_id,"thread_id":id,"text":parser.text(),
        "turns":"18446744073709551615","stream_format_version":1,"provider":"codex_cli","resource_scope":"direct_process",
    });
    if serde_json::to_vec(&result)
        .map_err(|_| "AI实时结果序列化失败")?
        .len()
        > apk_plugin_sdk::session::SESSION_FINISH_LIMIT.saturating_sub(4096)
    {
        return Err("AI实时结果超过公开终态帧限额".into());
    }
    let turns = state::complete(&resources, owner.project_id, owner.project, id, &context).await?;
    result["turns"] = json!(turns);
    Ok(Output::from(result))
}
