use super::transport::Outgoing;
use crate::{
    cleanup::Cleanup,
    resources::Resources,
    supervision::{Launch, NodeExit},
};
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, ScopeCompletion, ScopePolicy, StreamOptions,
    StreamingInput, ToolCommand, spawn_scoped_stream_with_lease,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{ffi::OsString, sync::Arc, time::Duration};
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeExit {
    format_version: u32,
    kind: String,
    call_id: String,
    nonce: String,
    process_id: u32,
    exit: NodeExit,
    complete: bool,
    forced: bool,
    #[serde(rename = "diagnostic_present")]
    _diagnostic_present: bool,
    transport_failed: bool,
}

pub struct Report {
    pub scope_complete: bool,
    pub outcome: Result<(), String>,
}

struct Frames {
    pending: Vec<u8>,
    ready: Option<oneshot::Sender<u32>>,
    pid: Option<u32>,
    candidate: Option<String>,
    diagnostic: Option<String>,
    terminal: Option<ScopeExit>,
}

impl Frames {
    fn frame(&mut self, launch: &Launch, bytes: &[u8]) -> Result<(), String> {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "SDK原生监督输出不是UTF-8 JSON")?;
        if value.get("format_version").and_then(Value::as_u64) != Some(1)
            || value.get("call_id").and_then(Value::as_str) != Some(&launch.call_id)
            || value.get("nonce").and_then(Value::as_str) != Some(&launch.nonce)
            || self.terminal.is_some()
        {
            return Err("SDK原生监督帧归属或终态冲突".into());
        }
        let pid = value
            .get("process_id")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .ok_or("SDK原生监督实际进程标识无效")?;
        match value.get("kind").and_then(Value::as_str) {
            Some("scope_error")
                if self.pid.is_none()
                    && self.diagnostic.is_none()
                    && value.as_object().is_some_and(|fields| fields.len() == 5) =>
            {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty() && message.len() <= 1024)
                    .ok_or("SDK原生监督范围错误缺少诊断")?;
                self.diagnostic = Some(message.into());
                Ok(())
            }
            Some("scope_ready")
                if self.pid.is_none()
                    && value.as_object().is_some_and(|fields| fields.len() == 5) =>
            {
                self.pid = Some(pid);
                self.ready
                    .take()
                    .ok_or("SDK原生启动身份已交付")?
                    .send(pid)
                    .map_err(|_| "SDK worker启动身份接收已关闭")?;
                Ok(())
            }
            Some("exit_candidate")
                if self.pid == Some(pid)
                    && self.candidate.is_none()
                    && value.as_object().is_some_and(|fields| fields.len() == 7)
                    && value.get("role").and_then(Value::as_str) == Some("worker") =>
            {
                let outcome = value
                    .get("outcome")
                    .and_then(Value::as_str)
                    .filter(|outcome| ["success", "failed", "cancelled"].contains(outcome))
                    .ok_or("SDK原生退出候选结果无效")?;
                self.candidate = Some(outcome.into());
                Ok(())
            }
            Some("scope_exit") if self.pid == Some(pid) => {
                let terminal: ScopeExit =
                    serde_json::from_value(value).map_err(|_| "SDK原生范围退出字段无效")?;
                if terminal.kind != "scope_exit"
                    || terminal.format_version != 1
                    || terminal.call_id != launch.call_id
                    || terminal.nonce != launch.nonce
                    || terminal.process_id != pid
                    || (terminal.exit.code.is_some() == terminal.exit.signal.is_some())
                {
                    return Err("SDK原生范围实际退出资格无效".into());
                }
                self.terminal = Some(terminal);
                Ok(())
            }
            _ => Err("SDK原生监督输出帧顺序无效".into()),
        }
    }

    fn feed(&mut self, launch: &Launch, bytes: &[u8]) -> Result<(), String> {
        for byte in bytes {
            if *byte == b'\n' {
                let pending = std::mem::take(&mut self.pending);
                self.frame(launch, &pending)?;
            } else {
                if self.pending.len() >= 16_384 {
                    return Err("SDK原生监督输出帧超限".into());
                }
                self.pending.push(*byte);
            }
        }
        Ok(())
    }
}

async fn stop_worker(
    context: &InvocationContext,
    control: &Arc<Mutex<Option<Outgoing>>>,
    input: &StreamingInput,
    until: std::time::Instant,
) -> Result<(), String> {
    let remaining = until
        .saturating_duration_since(std::time::Instant::now())
        .as_millis();
    if remaining == 0 || remaining > 1000 {
        return Err("SDK原生清理剩余窗口无效".into());
    }
    let reason = match context.check() {
        Err(deviceforge_plugin_runtime::ContextError::Timeout) => "timeout",
        Err(deviceforge_plugin_runtime::ContextError::Cancelled) => "cancelled",
        Ok(()) => "transport_failure",
    };
    let mut frame = serde_json::to_vec(&json!({"kind":"stop","remaining_ms":remaining as u64}))
        .map_err(|_| "SDK原生清理控制无法编码")?;
    frame.push(b'\n');
    let worker = async {
        if let Some(outgoing) = control.lock().await.clone() {
            outgoing
                .send_until(
                    tokio::time::Instant::from_std(until),
                    CancellationToken::new(),
                    json!({"kind":"stop","reason":reason}),
                )
                .await?;
        }
        Ok::<_, String>(())
    };
    let native = async {
        input
            .send(&frame)
            .await
            .map_err(|_| "SDK原生清理控制未交付".to_string())
    };
    let (_, native) = tokio::join!(worker, native);
    native
}

pub async fn run(
    launch: Launch,
    context: InvocationContext,
    stop: CancellationToken,
    cleanup: Arc<Cleanup>,
    resources: Arc<Resources>,
    control: Arc<Mutex<Option<Outgoing>>>,
    ready: oneshot::Sender<u32>,
) -> Report {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(_) => {
            return Report {
                scope_complete: true,
                outcome: Err("SDK原生监督入口不可用".into()),
            };
        }
    };
    let Some(executable) = executable.to_str() else {
        return Report {
            scope_complete: true,
            outcome: Err("SDK原生监督入口不是UTF-8".into()),
        };
    };
    let args = ["--sdk-supervisor".into()];
    let mut command = ToolCommand::new(executable, &args);
    command.environment = Environment::Restricted;
    for key in ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"] {
        command.env.insert(key.into(), OsString::new());
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env.insert("SystemRoot".into(), root);
    }
    let deadline = match context.deadline().checked_add(Duration::from_millis(1000)) {
        Some(deadline) => deadline,
        None => {
            return Report {
                scope_complete: true,
                outcome: Err("SDK原生监督清理期限无法表示".into()),
            };
        }
    };
    let mut execution = ExecutionOptions::new(tokio::time::Instant::from_std(deadline));
    execution.stdout_limit = 65_536;
    execution.stderr_limit = 16_384;
    execution.cleanup_timeout = Duration::from_millis(100);
    let mut options = StreamOptions::new(execution);
    options.channel_capacity = 32;
    options.input_limit = 65_792;
    let mut process = match spawn_scoped_stream_with_lease(
        command,
        options,
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
        resources,
    )
    .await
    {
        Ok(process) => process,
        Err(_) => {
            return Report {
                scope_complete: true,
                outcome: Err("SDK独立原生监督进程启动失败".into()),
            };
        }
    };
    let input = process.input();
    let mut bytes = match serde_json::to_vec(&launch) {
        Ok(bytes) if bytes.len() < 65_536 => bytes,
        _ => {
            process.cancel();
            stop.cancel();
            return Report {
                scope_complete: false,
                outcome: Err("SDK原生启动帧超限或无效".into()),
            };
        }
    };
    bytes.push(b'\n');
    for chunk in bytes.chunks(8192) {
        if input.send(chunk).await.is_err() {
            process.cancel();
            stop.cancel();
            return Report {
                scope_complete: false,
                outcome: Err("SDK原生启动帧未交付".into()),
            };
        }
    }
    let mut frames = Frames {
        pending: Vec::new(),
        ready: Some(ready),
        pid: None,
        candidate: None,
        diagnostic: None,
        terminal: None,
    };
    let mut error = None;
    let mut stopped = false;
    let mut closed = false;
    let mut diagnostic = Vec::new();
    let mut updates = cleanup.subscribe();
    loop {
        let until = match cleanup.current() {
            Ok(Some(until)) => until,
            Ok(None) => context.deadline(),
            Err(failure) => {
                error = Some(failure);
                break;
            }
        };
        tokio::select! {
            biased;
            _ = stop.cancelled(), if !stopped && !closed => {
                stopped = true;
                let until = match cleanup.until() { Ok(until) => until, Err(failure) => { error = Some(failure); break; } };
                if let Err(failure) = tokio::time::timeout_at(tokio::time::Instant::from_std(until), stop_worker(&context, &control, &input, until)).await.unwrap_or_else(|_| Err("SDK原生清理控制期限已到期".into())) { error = Some(failure); break; }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(until)) => {
                if cleanup.current().ok().flatten().is_some() { error = Some("SDK原生范围和监督进程实际结束未确认".into()); break; }
                stop.cancel();
            }
            _ = updates.changed() => {}
            chunk = process.recv() => match chunk {
                Some(chunk) if chunk.stream == OutputStream::Stdout => {
                    if let Err(failure) = frames.feed(&launch, &chunk.bytes) { error = Some(failure); stop.cancel(); }
                    if frames.terminal.is_some() && !closed {
                        if cleanup.until().is_err() || input.close().await.is_err() { error = Some("SDK原生控制输入关闭失败".into()); break; }
                        closed = true;
                    }
                }
                Some(chunk) => {
                    if diagnostic.len() < 16_384 {
                        let remaining = 16_384 - diagnostic.len();
                        diagnostic.extend_from_slice(&chunk.bytes[..chunk.bytes.len().min(remaining)]);
                    }
                }
                None => break,
            }
        }
    }
    if error.is_some() {
        process.cancel();
        stop.cancel();
    }
    let until = match cleanup.until() {
        Ok(until) => until,
        Err(failure) => {
            return Report {
                scope_complete: false,
                outcome: Err(failure),
            };
        }
    };
    let outer = match tokio::time::timeout_at(tokio::time::Instant::from_std(until), process.wait())
        .await
    {
        Ok(Ok(direct)) => direct,
        _ => {
            return Report {
                scope_complete: false,
                outcome: Err("SDK独立原生监督进程实际退出未确认".into()),
            };
        }
    };
    if outer.scope != ScopeCompletion::Complete {
        return Report {
            scope_complete: false,
            outcome: Err("SDK独立原生监督外层完整范围退出未确认".into()),
        };
    }
    let direct = match outer.direct {
        Ok(direct) => direct,
        Err(_) => {
            return Report {
                scope_complete: false,
                outcome: Err("SDK独立原生监督直接退出未确认".into()),
            };
        }
    };
    if let Some(diagnostic) = frames.diagnostic {
        return Report {
            scope_complete: true,
            outcome: Err(format!("SDK原生监督范围启动失败：{diagnostic}")),
        };
    }
    if !direct.status.success() || !frames.pending.is_empty() || !closed {
        return Report {
            scope_complete: false,
            outcome: Err("SDK独立原生监督缺少零退出和完整范围终态".into()),
        };
    }
    let Some(terminal) = frames.terminal else {
        return Report {
            scope_complete: false,
            outcome: Err("SDK独立原生监督缺少范围终态".into()),
        };
    };
    if !terminal.complete {
        return Report {
            scope_complete: false,
            outcome: Err("SDK原生成员实际退出未确认".into()),
        };
    }
    let outcome = if let Some(error) = error {
        Err(error)
    } else if terminal.forced
        || terminal.transport_failed
        || terminal.exit.code != Some(0)
        || terminal.exit.signal.is_some()
        || frames.candidate.as_deref() != Some("success")
        || stopped
    {
        Err(format!(
            "SDK worker缺少正常成功退出资格：forced={}、transport_failed={}、exit_code={:?}、signal={:?}、candidate={:?}、stopped={}、stdout_bytes={}、stderr_bytes={}、diagnostic={}、scope_error={}",
            terminal.forced,
            terminal.transport_failed,
            terminal.exit.code,
            terminal.exit.signal,
            frames.candidate,
            stopped,
            direct.stdout_bytes,
            direct.stderr_bytes,
            String::from_utf8_lossy(&diagnostic).trim(),
            frames.diagnostic.as_deref().unwrap_or(""),
        ))
    } else {
        Ok(())
    };
    Report {
        scope_complete: true,
        outcome,
    }
}
