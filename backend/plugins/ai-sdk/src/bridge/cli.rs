use super::{
    argv,
    framing::{CHUNK_LIMIT, Role, bytes},
    transport::{Identity, Incoming, Outgoing, accept},
    worker,
};
use crate::{cleanup::Cleanup, config::Config, model::TurnInput, resources::Resources};
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, ScopeCompletion, ScopePolicy,
    ScopedStreamingProcess, StreamOptions, ToolCommand, spawn_scoped_stream_with_lease,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_util::sync::CancellationToken;

pub struct Work {
    pub config: Arc<Config>,
    pub input: TurnInput,
    pub project_root: PathBuf,
    pub temporary: PathBuf,
    pub output_schema: Option<Value>,
    pub resources: Arc<Resources>,
    pub raw: mpsc::Sender<Value>,
}

pub struct Report {
    pub scope_complete: bool,
    pub outcome: Result<(), String>,
}

fn environment(work: &Work) -> BTreeMap<OsString, OsString> {
    let mut values: BTreeMap<OsString, OsString> =
        ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
            .into_iter()
            .map(|name| (name.into(), OsString::new()))
            .collect();
    if let Some(root) = std::env::var_os("SystemRoot") {
        values.insert("SystemRoot".into(), root);
    }
    for (name, value) in &work.config.environment {
        values.insert(name.into(), value.into());
    }
    values.insert("HOME".into(), work.config.codex_home.as_os_str().into());
    values.insert(
        "USERPROFILE".into(),
        work.config.codex_home.as_os_str().into(),
    );
    values.insert(
        "CODEX_HOME".into(),
        work.config.codex_home.as_os_str().into(),
    );
    values.insert("TEMP".into(), work.temporary.as_os_str().into());
    values.insert("TMP".into(), work.temporary.as_os_str().into());
    values.insert(
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into(),
        "codex_sdk_ts".into(),
    );
    values
}

async fn input(
    context: &InvocationContext,
    incoming: &mut Incoming,
    expected: &[u8],
) -> Result<(), String> {
    let mut offset = 0usize;
    loop {
        let payload = incoming
            .read(context)
            .await?
            .ok_or("SDK私有代理缺少完整输入")?;
        let fields = payload.as_object().ok_or("SDK私有代理输入不是对象")?;
        match payload.get("kind").and_then(Value::as_str) {
            Some("stdin_bytes") if fields.len() == 2 => {
                let chunk = bytes(&payload)?;
                if chunk.len() > expected.len().saturating_sub(offset)
                    || expected[offset..offset + chunk.len()] != chunk
                {
                    return Err("SDK实际标准输入与原提示词不匹配".into());
                }
                offset += chunk.len();
            }
            Some("stdin_end") if fields.len() == 1 && offset == expected.len() => return Ok(()),
            _ => return Err("SDK私有代理输入顺序或完整性无效".into()),
        }
    }
}

struct Lines {
    pending: Vec<u8>,
    count: usize,
}

impl Lines {
    async fn line(
        &mut self,
        context: &InvocationContext,
        work: &Work,
        outgoing: &Outgoing,
        newline: bool,
    ) -> Result<(), String> {
        if self.pending.is_empty() {
            return Err("SDK真实CLI输出空JSON行".into());
        }
        self.count += 1;
        if self.count > 10_000 {
            return Err("SDK真实CLI事件数量超限".into());
        }
        let value: Value =
            serde_json::from_slice(&self.pending).map_err(|_| "SDK真实CLI事件不是UTF-8 JSON")?;
        if value.get("type").and_then(Value::as_str) == Some("thread.started") {
            let thread = value
                .get("thread_id")
                .and_then(Value::as_str)
                .ok_or("SDK真实CLI线程标识无效")?;
            work.resources.register(context, thread.into()).await?;
        }
        work.raw
            .send(value)
            .await
            .map_err(|_| "SDK worker真实事件接收已关闭")?;
        if newline {
            self.pending.push(b'\n');
        }
        for chunk in self.pending.chunks(CHUNK_LIMIT) {
            outgoing
                .send(
                    context,
                    json!({"kind":"output","stream":"stdout","bytes":chunk}),
                )
                .await?;
        }
        self.pending.clear();
        Ok(())
    }

    async fn feed(
        &mut self,
        context: &InvocationContext,
        work: &Work,
        outgoing: &Outgoing,
        bytes: &[u8],
    ) -> Result<(), String> {
        for byte in bytes {
            if *byte == b'\n' {
                self.line(context, work, outgoing, true).await?;
            } else {
                if self.pending.len() >= 65_536 {
                    return Err("SDK真实CLI JSON行超过64KiB".into());
                }
                self.pending.push(*byte);
            }
        }
        Ok(())
    }
}

async fn output(
    context: &InvocationContext,
    work: &Work,
    process: &mut ScopedStreamingProcess,
    outgoing: &Outgoing,
) -> Result<(), String> {
    let mut lines = Lines {
        pending: Vec::new(),
        count: 0,
    };
    while let Some(chunk) = process.recv().await {
        context.check().map_err(|error| error.to_string())?;
        match chunk.stream {
            OutputStream::Stdout => lines.feed(context, work, outgoing, &chunk.bytes).await?,
            OutputStream::Stderr => {
                outgoing
                    .send(
                        context,
                        json!({"kind":"output","stream":"stderr","bytes":chunk.bytes}),
                    )
                    .await?
            }
        }
    }
    if !lines.pending.is_empty() {
        lines.line(context, work, outgoing, false).await?;
    }
    Ok(())
}

pub async fn run(
    listener: TcpListener,
    identity: Identity,
    work: Work,
    context: InvocationContext,
    stop: CancellationToken,
    cleanup: Arc<Cleanup>,
) -> Report {
    let mut process = None;
    let mut outgoing = None;
    let outcome = tokio::select! {
        biased;
        _ = stop.cancelled() => Err("SDK真实CLI调用已停止".into()),
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(context.deadline())) => Err("SDK真实CLI调用期限已到期".into()),
        outcome = async {
            let (mut incoming, connection) = accept(&listener, &context, &identity, Role::Proxy).await?;
            let hello = incoming.read(&context).await?.ok_or("SDK代理缺少本机开始帧")?;
            worker::hello(hello, None)?;
            let remaining = context.deadline().saturating_duration_since(std::time::Instant::now()).as_millis();
            if remaining == 0 || remaining > 600_000 { return Err("SDK代理准入原预算无效".into()); }
            connection.send(&context, json!({"kind":"accepted","remaining_ms":remaining as u64})).await?;
            outgoing = Some(connection.clone());
            let payload = incoming.read(&context).await?.ok_or("SDK代理缺少exec请求")?;
            let fields = payload.as_object().ok_or("SDK代理exec请求不是对象")?;
            if fields.len() != 2 || payload.get("kind").and_then(Value::as_str) != Some("exec") { return Err("SDK代理exec字段无效".into()); }
            let argv: Vec<String> = serde_json::from_value(payload.get("argv").cloned().ok_or("SDK代理缺少实际参数")?).map_err(|_| "SDK代理实际参数无效")?;
            argv::verify(&context, &work.config, &work.project_root, work.input.thread_id.as_deref(), &work.temporary, work.output_schema.as_ref(), &argv).await?;
            input(&context, &mut incoming, work.input.prompt.as_bytes()).await?;
            let executable = work.config.cli_executable.to_str().ok_or("SDK部署CLI入口不是UTF-8")?;
            let mut command = ToolCommand::new(executable, &argv);
            command.directory = Some(&work.project_root);
            command.environment = Environment::Restricted;
            command.env = environment(&work);
            let mut execution = ExecutionOptions::new(tokio::time::Instant::from_std(context.deadline()));
            execution.stdout_limit = 4 * 1024 * 1024;
            execution.stderr_limit = 1024 * 1024;
            execution.cleanup_timeout = Duration::from_millis(1000);
            let mut options = StreamOptions::new(execution);
            options.channel_capacity = 32;
            options.input_limit = work.input.prompt.len() as u64;
            process = Some(spawn_scoped_stream_with_lease(command, options, stop.clone(), ScopePolicy::OwnedTree, work.resources.clone()).await.map_err(|_| "SDK真实CLI完整范围启动失败")?);
            let process = process.as_mut().ok_or("SDK真实CLI所有权未建立")?;
            let input = process.input();
            let feed = async {
                for chunk in work.input.prompt.as_bytes().chunks(CHUNK_LIMIT) { input.send(chunk).await.map_err(|_| "SDK真实CLI标准输入失败".to_string())?; }
                input.close().await.map_err(|_| "SDK真实CLI输入关闭失败".to_string())
            };
            tokio::try_join!(feed, output(&context, &work, process, &connection))?;
            Ok(())
        } => outcome,
    };
    if outcome.is_err() {
        stop.cancel();
    }
    let Some(process) = process.as_mut() else {
        return Report {
            scope_complete: true,
            outcome,
        };
    };
    if outcome.is_err() {
        process.cancel();
    }
    let until = match cleanup.until() {
        Ok(until) => until,
        Err(error) => {
            return Report {
                scope_complete: false,
                outcome: Err(error),
            };
        }
    };
    let terminal = match tokio::time::timeout_at(
        tokio::time::Instant::from_std(until),
        process.wait(),
    )
    .await
    {
        Ok(Ok(terminal)) => terminal,
        _ => {
            stop.cancel();
            return Report {
                scope_complete: false,
                outcome: Err("SDK真实CLI完整范围实际退出未确认".into()),
            };
        }
    };
    let scope_complete = matches!(terminal.scope, ScopeCompletion::Complete);
    if !scope_complete {
        stop.cancel();
        return Report {
            scope_complete: false,
            outcome: Err("SDK真实CLI完整范围清理失败".into()),
        };
    }
    let direct = match terminal.direct {
        Ok(direct) => direct,
        Err(_) => {
            return Report {
                scope_complete: true,
                outcome: Err("SDK真实CLI直接退出失败或业务已停止".into()),
            };
        }
    };
    let outcome = match outcome {
        Err(error) => Err(error),
        Ok(()) => {
            if let Some(outgoing) = outgoing {
                let sent = outgoing
                    .send(&context, json!({"kind":"exit","code":direct.status.code()}))
                    .await;
                if !direct.status.success() {
                    Err("SDK真实CLI非零退出".into())
                } else {
                    sent
                }
            } else {
                Err("SDK代理退出通道未建立".into())
            }
        }
    };
    if outcome.is_err() {
        stop.cancel();
    }
    Report {
        scope_complete: true,
        outcome,
    }
}
