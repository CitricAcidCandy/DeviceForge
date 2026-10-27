//! 协议 6 双向泵；子调用只进入领域端口，与协议 3/4 共用直接进程及租约归属。
use super::service_stdin::ClosingStdin;
use super::{CleanupGuard, Invocation, bounded, command, ownership};
use apk_domain::{
    Error, Result,
    services::{ServiceCaller, ServiceRef},
};
use apk_plugin_sdk::{Response, cooperative::CleanupOutcome, services::*};
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

type ChildCall = Pin<Box<dyn Future<Output = (String, Result<serde_json::Value>)> + Send>>;

struct CancelChildren(CancellationToken);
impl Drop for CancelChildren {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn line<R: AsyncBufRead + Unpin>(reader: &mut R, bytes: &mut Vec<u8>) -> Result<Vec<u8>> {
    loop {
        let available = reader.fill_buf().await.map_err(|_| Error::CleanupFailed)?;
        if available.is_empty() {
            return Err(Error::CleanupFailed);
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > FRAME_LIMIT {
            return Err(Error::CleanupFailed);
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(std::mem::take(bytes));
        }
    }
}

async fn write<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &ServiceFrame,
    deadline: Instant,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| Error::CleanupFailed)?;
    if bytes.len() >= FRAME_LIMIT {
        return Err(Error::CleanupFailed);
    }
    bytes.push(b'\n');
    tokio::time::timeout_at(deadline, async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| Error::CleanupFailed)?
    .map_err(|_| Error::CleanupFailed)
}

pub(super) async fn exchange<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    id: &str,
    deadline: Instant,
    cancel: &CancellationToken,
    caller: Arc<dyn ServiceCaller>,
) -> Result<Response> {
    let mut buffer = Vec::new();
    let ready_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
    let mut interrupted = None;
    let mut until = deadline;
    let ready = {
        let read = line(reader, &mut buffer);
        tokio::pin!(read);
        tokio::select! { biased;
            _ = cancel.cancelled() => {
                interrupted = Some(Instant::now() >= deadline);
                until = Instant::now() + Duration::from_millis(1250);
                tokio::time::timeout_at(until, &mut read).await.map_err(|_| Error::CleanupFailed)??
            },
            _ = tokio::time::sleep_until(ready_deadline) => {
                if ready_deadline < deadline { return Err(Error::CleanupFailed); }
                interrupted = Some(true);
                until = deadline + Duration::from_millis(1250);
                tokio::time::timeout_at(until, &mut read).await.map_err(|_| Error::CleanupFailed)??
            },
            result = &mut read => result?,
        }
    };
    if ready.len() > 4096 {
        return Err(Error::CleanupFailed);
    }
    let ready: ServiceFrame = serde_json::from_slice(&ready).map_err(|_| Error::CleanupFailed)?;
    ready.validate(id).map_err(|_| Error::CleanupFailed)?;
    if !matches!(ready, ServiceFrame::Ready { .. }) {
        return Err(Error::CleanupFailed);
    }
    if interrupted.is_some() || cancel.is_cancelled() || Instant::now() >= deadline {
        if interrupted.is_none() {
            interrupted = Some(Instant::now() >= deadline);
            until = Instant::now() + Duration::from_millis(1250);
        }
        write(
            writer,
            &ServiceFrame::Cancel {
                protocol_version: 6,
                request_id: id.into(),
            },
            until,
        )
        .await?;
    } else {
        let frame = ServiceFrame::Start {
            protocol_version: 6,
            request_id: id.into(),
            remaining_timeout_ns: u64::try_from(
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_nanos(),
            )
            .map_err(|_| Error::CleanupFailed)?,
        };
        frame.validate(id).map_err(|_| Error::CleanupFailed)?;
        write(writer, &frame, deadline).await?;
    }
    let mut active = BTreeMap::<String, CancellationToken>::new();
    let children = CancelChildren(cancel.child_token());
    let mut seen = BTreeSet::new();
    let mut work = FuturesUnordered::<ChildCall>::new();
    let mut finished = None;
    let mut child_cleanup_failed = false;
    let mut total = 0usize;
    loop {
        if finished.is_some() && work.is_empty() {
            break;
        }
        tokio::select! { biased;
            _ = tokio::time::sleep_until(until) => {
                if interrupted.is_some() || finished.is_some() { return Err(Error::CleanupFailed); }
                interrupted = Some(true);
                until = deadline + Duration::from_millis(1250);
                for token in active.values() { token.cancel(); }
                write(writer, &ServiceFrame::Cancel { protocol_version: 6, request_id: id.into() }, until).await?;
            },
            _ = cancel.cancelled(), if interrupted.is_none() && finished.is_none() => {
                interrupted = Some(Instant::now() >= deadline);
                until = Instant::now() + Duration::from_millis(1250);
                for token in active.values() { token.cancel(); }
                write(writer, &ServiceFrame::Cancel { protocol_version: 6, request_id: id.into() }, until).await?;
            },
            frame = line(reader, &mut buffer), if finished.is_none() => {
                let bytes = frame?;
                total += bytes.len();
                if total > 16 * 1024 * 1024 { return Err(Error::CleanupFailed); }
                let frame: ServiceFrame = serde_json::from_slice(&bytes).map_err(|_| Error::CleanupFailed)?;
                frame.validate(id).map_err(|_| Error::CleanupFailed)?;
                match frame {
                    ServiceFrame::ServiceCall { call_id, service, input, .. } => {
                        if !seen.insert(call_id.clone()) || seen.len() > 1024 { return Err(Error::CleanupFailed); }
                        if active.len() >= 4 || interrupted.is_some() {
                            write(writer, &ServiceFrame::ServiceResult { protocol_version: 6, request_id: id.into(), call_id,
                                outcome: ServiceOutcome::Failed { error: ServiceFailure { code: "conflict".into(), message: "服务子调用容量已满或父调用已停止".into() } } }, until).await?;
                            continue;
                        }
                        let token = children.0.child_token();
                        active.insert(call_id.clone(), token.clone());
                        let caller = caller.clone();
                        work.push(Box::pin(async move {
                            let result = caller.call(ServiceRef { id: service.id, version: service.version }, input, token).await;
                            (call_id, result)
                        }));
                    },
                    ServiceFrame::ServiceCancel { call_id, .. } => {
                        if !seen.contains(&call_id) { return Err(Error::CleanupFailed); }
                        if let Some(token) = active.get(&call_id) { token.cancel(); }
                    },
                    ServiceFrame::Finished { execution, .. } => {
                        if execution.cleanup != CleanupOutcome::Complete || execution.response.protocol_version != 6
                            || execution.response.request_id != id { return Err(Error::CleanupFailed); }
                        match (&execution.response.result, &execution.response.error) {
                            (Some(_), None) => {},
                            (None, Some(error)) if !error.trim().is_empty() && execution.response.outputs.is_empty() => {},
                            _ => return Err(Error::CleanupFailed),
                        }
                        for token in active.values() { token.cancel(); }
                        // 业务结束与清理确认分别计时；不能用剩余业务预算截断子调用清理。
                        if interrupted.is_none() { until = Instant::now() + Duration::from_millis(1250); }
                        finished = Some(execution.response);
                        writer.shutdown().await.map_err(|_| Error::CleanupFailed)?;
                    },
                    _ => return Err(Error::CleanupFailed),
                }
            },
            Some((call_id, result)) = work.next(), if !work.is_empty() => {
                active.remove(&call_id);
                child_cleanup_failed |= matches!(result, Err(Error::CleanupFailed));
                if finished.is_none() {
                    let outcome = match result { Ok(result) => ServiceOutcome::Succeeded { result }, Err(error) => ServiceOutcome::Failed {
                        error: ServiceFailure { code: error.code().into(), message: match error {
                            Error::Storage(_) | Error::Dependency(_) => "服务依赖或结果异常".into(), other => other.to_string(),
                        } }
                    }};
                    write(writer, &ServiceFrame::ServiceResult { protocol_version: 6, request_id: id.into(), call_id, outcome }, until).await?;
                }
            },
        }
    }
    if child_cleanup_failed {
        return Err(Error::CleanupFailed);
    }
    let mut trailing = [0u8; 1];
    if tokio::time::timeout_at(until, reader.read(&mut trailing))
        .await
        .map_err(|_| Error::CleanupFailed)?
        .map_err(|_| Error::CleanupFailed)?
        != 0
    {
        return Err(Error::CleanupFailed);
    }
    match interrupted {
        Some(true) => Err(Error::Timeout),
        Some(false) => Err(Error::Cancelled),
        None => Ok(finished.expect("已收到终态")),
    }
}

pub(crate) async fn run(
    call: Invocation<'_>,
    unresolved: Arc<AtomicBool>,
    caller: Arc<dyn ServiceCaller>,
) -> Result<Response> {
    let deadline = call
        .deadline
        .map(Instant::from_std)
        .unwrap_or_else(|| Instant::now() + call.timeout);
    crate::execution_deadline::check(&call.cancel, Some(deadline))?;
    let lease =
        crate::plugin_resources::acquire(call.resources, &call.cancel, deadline, &unresolved)
            .await?;
    let mut cmd = command(lease.executable(call.executable), call.args, true);
    if let Some(path) = call.configuration {
        cmd.env("DEVICEFORGE_PLUGIN_CONFIG", path);
    }
    if let Some(path) = call.resources {
        cmd.env("DEVICEFORGE_PLUGIN_RESOURCES", path);
    }
    if let Some(path) = call.directory {
        cmd.current_dir(path);
        for key in ["TEMP", "TMP", "TMPDIR"] {
            cmd.env(key, path);
        }
    }
    crate::execution_deadline::check(&call.cancel, Some(deadline))?;
    let process = cmd
        .spawn()
        .map_err(|_| Error::Dependency("服务插件进程启动失败".into()))?;
    let mut child = ownership::Owner::new(process, lease.clone());
    let mut guard = CleanupGuard {
        unresolved,
        confirmed: false,
        lease,
    };
    let mut stdin = ClosingStdin::new(child.stdin.take().ok_or(Error::CleanupFailed)?);
    let mut stdout = BufReader::new(child.stdout.take().ok_or(Error::CleanupFailed)?);
    let stderr = child.stderr.take().ok_or(Error::CleanupFailed)?;
    let terminal = tokio::sync::Notify::new();
    let exchange = async {
        let result = if !super::send_request(&mut stdin, &call.input, deadline, &call.cancel).await
        {
            Err(Error::CleanupFailed)
        } else {
            exchange(
                &mut stdout,
                &mut stdin,
                call.request_id,
                deadline,
                &call.cancel,
                caller,
            )
            .await
        };
        terminal.notify_one();
        let _ = stdin.shutdown().await;
        result
    };
    let result = {
        let work = async {
            let (response, errors, status) = tokio::join!(exchange, bounded(stderr), child.wait());
            errors.map_err(|_| Error::CleanupFailed)?;
            if status.map_err(|_| Error::CleanupFailed)?.success() {
                response
            } else {
                Err(Error::CleanupFailed)
            }
        };
        tokio::pin!(work);
        let mut cleanup = None;
        loop {
            tokio::select! { biased;
                _ = async { match cleanup { Some(until) => tokio::time::sleep_until(until).await, None => std::future::pending().await } } => break Err(Error::CleanupFailed),
                _ = call.cancel.cancelled(), if cleanup.is_none() => cleanup = Some(Instant::now() + Duration::from_millis(1250)),
                _ = tokio::time::sleep_until(deadline), if cleanup.is_none() => cleanup = Some(deadline + Duration::from_millis(1250)),
                _ = terminal.notified(), if cleanup.is_none() => cleanup = Some(Instant::now() + Duration::from_millis(1250)),
                result = &mut work => break result,
            }
        }
    };
    guard.confirmed = matches!(&result, Ok(_) | Err(Error::Timeout) | Err(Error::Cancelled));
    if !guard.confirmed {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
    }
    result
}
