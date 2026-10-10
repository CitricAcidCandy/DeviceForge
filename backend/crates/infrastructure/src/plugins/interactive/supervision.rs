//! 独立会话监督；业务撤销先合作清理，硬回收不伪造资源确认。
use super::{handles::{self, Channels}, transport::{self, Reader}};
use crate::{execution_deadline, plugin_artifacts::InvocationFiles};
use apk_domain::{Error, Result, artifacts::ArtifactStore, interactive::*};
use apk_plugin_sdk::{Manifest, session::*};
use deviceforge_tool_process::{Environment, ExecutionOptions, StreamOptions, ToolCommand};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
mod pump;

pub(super) struct Call {
    pub manifest: Manifest,
    pub artifacts: Option<Arc<dyn ArtifactStore>>,
    pub unresolved: Arc<AtomicBool>,
    pub request: SessionRequest,
    pub cancel: CancellationToken,
    pub channels: Channels,
}

struct Guard {
    unresolved: Arc<AtomicBool>,
    channels: ChannelsNotice,
    spawned: bool,
    finished: bool,
}

struct ChannelsNotice {
    ready: tokio::sync::watch::Sender<Option<SessionResult<()>>>,
    exit: tokio::sync::watch::Sender<Option<Arc<SessionExit>>>,
    revoked: CancellationToken,
}

impl Guard {
    fn finish(&mut self, exit: SessionExit) {
        if self.spawned && exit.cleanup != SessionCleanup::Complete {
            self.unresolved.store(true, Ordering::Release);
        }
        if self.channels.ready.borrow().is_none() {
            self.channels.ready.send_replace(Some(Err(exit.failure.clone()
                .unwrap_or_else(|| Arc::new(Error::CleanupFailed)))));
        }
        self.channels.exit.send_replace(Some(Arc::new(exit)));
        self.finished = true;
        // 先发布真实缓存结论，再唤醒撤销等待，避免将已知错误降成输入关闭。
        self.channels.revoked.cancel();
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.finished {
            // 被丢弃的监督不能等待；公共进程后台仍持有直接进程及文件租约。
            self.finish(failed(Error::CleanupFailed, false));
        }
    }
}

fn failed(error: Error, process_exited: bool) -> SessionExit {
    SessionExit { sequence: None, outcome: None, cleanup: SessionCleanup::Unconfirmed,
        process_exited, failure: Some(Arc::new(error)) }
}

pub(super) async fn run(mut call: Call) {
    let mut guard = Guard { unresolved: call.unresolved.clone(), spawned: false, finished: false,
        channels: ChannelsNotice { ready: call.channels.ready.clone(), exit: call.channels.exit.clone(),
            revoked: call.channels.revoked.clone() } };
    let exit = execute(&mut call, &mut guard).await;
    guard.finish(exit);
}

async fn execute(call: &mut Call, guard: &mut Guard) -> SessionExit {
    let deadline = Instant::from_std(call.request.deadline);
    if let Err(error) = execution_deadline::check(&call.cancel, Some(deadline)) {
        return failed(error, false);
    }
    let files = match InvocationFiles::prepare_until(call.artifacts.as_deref(),
        call.manifest.artifacts.as_ref(), &call.request.input, call.cancel.clone(), Some(deadline)).await {
        Ok(files) => Arc::new(files),
        Err(error) => return failed(error, false),
    };
    if let Err(error) = execution_deadline::check(&call.cancel, Some(deadline)) {
        return failed(error, false);
    }
    let mut execution = ExecutionOptions::new(deadline + transport::CLEANUP + transport::EXIT);
    // JSON 数组有编码膨胀，业务字节/事件上限另在 pump 中精确执行。
    execution.stdout_limit = 128 * 1024 * 1024;
    execution.stderr_limit = 1024 * 1024;
    let mut options = StreamOptions::new(execution);
    options.chunk_size = 65536;
    options.channel_capacity = handles::CAPACITY;
    options.input_limit = 32 * 1024 * 1024;
    let mut command = ToolCommand::new(&call.manifest.executable, &call.manifest.args);
    command.environment = Environment::Restricted;
    command.directory = Some(files.directory.path());
    for name in ["TEMP", "TMP", "TMPDIR"] {
        command.env.insert(name.into(), files.directory.path().as_os_str().to_owned());
    }
    // 业务 token 不传给硬监督；清理宽限由会话监督管理。
    let hard_cancel = CancellationToken::new();
    let mut process = match deviceforge_tool_process::spawn_stream_with_lease(command, options,
        hard_cancel, files.clone()).await {
        Ok(process) => process,
        Err(_) => return failed(Error::Dependency("会话插件进程启动失败".into()), false),
    };
    guard.spawned = true;
    let mut reader = Reader::new();
    let handshake = handshake(call, &mut process, &mut reader, &files, deadline).await;
    if let Err(error) = handshake {
        process.cancel();
        let reaped = process.wait().await;
        return failed(error, !matches!(reaped, Err(deviceforge_tool_process::Error::CleanupFailed { .. })));
    }
    call.channels.ready.send_replace(Some(Ok(())));
    let (mut exit, outputs) = pump::run(call, &mut process, &mut reader, deadline).await;
    if exit.cleanup == SessionCleanup::Complete && exit.failure.is_none()
        && let Some(outcome) = &mut exit.outcome
        && outcome.error.is_none()
    {
        match files.publish_until(call.artifacts.as_deref(), outputs, call.cancel.clone(), Some(deadline)).await {
            Ok(artifacts) => outcome.artifacts = artifacts,
            Err(error) => exit.failure = Some(Arc::new(error)),
        }
    }
    exit
}

async fn handshake(call: &Call, process: &mut deviceforge_tool_process::StreamingProcess,
    reader: &mut Reader, files: &InvocationFiles, deadline: Instant) -> Result<()> {
    let fixed = (Instant::now() + transport::HANDSHAKE).min(deadline);
    let prefix = format!("plugin.{}.", call.manifest.id);
    let operation = call.request.operation.strip_prefix(&prefix)
        .ok_or_else(|| Error::NotFound(call.request.operation.clone()))?;
    let mut open = SessionOpen::new(&call.request.session_id, operation, call.request.input.clone());
    open.artifacts = Some(files.context.clone());
    let bytes = transport::frame(&open, SESSION_OPEN_LIMIT)?;
    let input = process.input();
    tokio::select! {
        biased;
        _ = call.cancel.cancelled() => return Err(Error::Cancelled),
        result = transport::send(&input, &bytes, fixed) => result?,
    }
    let bytes = tokio::select! {
        biased;
        _ = call.cancel.cancelled() => return Err(Error::Cancelled),
        result = tokio::time::timeout_at(fixed, reader.next(process, SESSION_HANDSHAKE_LIMIT)) => {
            result.map_err(|_| Error::Timeout)??.ok_or_else(|| Error::Dependency("会话插件未发送 Ready".into()))?
        },
    };
    let ready: SessionReady = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Dependency("会话 Ready 无效".into()))?;
    if ready.validate().is_err() || ready.session_id != call.request.session_id {
        return Err(Error::Dependency("会话 Ready 关联不匹配".into()));
    }
    execution_deadline::check(&call.cancel, Some(deadline))?;
    let remaining = u64::try_from(deadline.saturating_duration_since(Instant::now()).as_nanos())
        .map_err(|_| Error::Invalid("会话剩余预算无效".into()))?;
    let start = SessionStart::new(&call.request.session_id, remaining);
    start.validate().map_err(|message| Error::Invalid(message.into()))?;
    let bytes = transport::frame(&start, SESSION_HANDSHAKE_LIMIT)?;
    tokio::select! {
        biased;
        _ = call.cancel.cancelled() => Err(Error::Cancelled),
        result = transport::send(&input, &bytes, fixed) => result,
    }
}
