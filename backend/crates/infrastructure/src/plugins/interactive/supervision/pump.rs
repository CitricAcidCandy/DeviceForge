//! 同时推进数据、控制与读取；取消不等待满输出队列。
use super::Call;
use crate::plugins::interactive::{
    handles,
    transport::{self, Reader},
};
use apk_domain::{Error, Result, interactive::*};
use apk_plugin_sdk::{
    ArtifactOutput,
    cooperative::{CancelReason, CleanupOutcome},
    session::{self, SessionControl, SessionEvent},
};
use deviceforge_tool_process::StreamingProcess;
use futures_util::future::BoxFuture;
use std::sync::Arc;
use tokio::time::Instant;

fn write(
    input: deviceforge_tool_process::StreamingInput,
    bytes: Vec<u8>,
    deadline: Instant,
) -> BoxFuture<'static, Result<()>> {
    Box::pin(async move { transport::send(&input, &bytes, deadline).await })
}

pub(super) async fn run(
    call: &mut Call,
    process: &mut StreamingProcess,
    reader: &mut Reader,
    deadline: Instant,
) -> (SessionExit, Vec<ArtifactOutput>) {
    let mut failure: Option<Arc<Error>> = None;
    let mut stop_at = None;
    let mut exit_at = None;
    let mut pending_write: Option<BoxFuture<'static, Result<()>>> = None;
    let mut pending_output: Option<SessionChunk> = None;
    let mut terminal = None;
    let mut expected = 1u64;
    let mut output_bytes = 0u64;
    let mut events = 0u64;
    let input = process.input();
    let mut protocol_valid = true;

    loop {
        if failure.is_none()
            && terminal.is_none()
            && (call.cancel.is_cancelled() || Instant::now() >= deadline)
        {
            let timeout = Instant::now() >= deadline;
            failure = Some(Arc::new(if timeout {
                Error::Timeout
            } else {
                Error::Cancelled
            }));
            let until = Instant::now() + transport::CLEANUP;
            stop_at = Some(until);
            call.channels.revoked.cancel();
            call.channels.commands.close();
            pending_output.take();
            pending_write.take();
            let control = SessionControl::Cancel {
                protocol_version: session::SESSION_PROTOCOL_VERSION,
                session_id: call.request.session_id.clone(),
                reason: if timeout {
                    CancelReason::Timeout
                } else {
                    CancelReason::Cancelled
                },
            };
            match transport::frame(&control, session::SESSION_FRAME_LIMIT) {
                Ok(bytes) => pending_write = Some(write(input.clone(), bytes, until)),
                Err(_) => {
                    protocol_valid = false;
                    break;
                }
            }
        }
        // Finished 之后只核对剩余传输和真实退出，不再发业务取消或接受输入。
        let hard = exit_at.or(stop_at).unwrap_or(deadline);
        tokio::select! {
            biased;
            _ = call.cancel.cancelled(), if failure.is_none() && terminal.is_none() => {},
            _ = tokio::time::sleep_until(deadline), if failure.is_none() && terminal.is_none() => {},
            _ = tokio::time::sleep_until(hard), if stop_at.is_some() || exit_at.is_some() => {
                failure.get_or_insert_with(|| Arc::new(Error::CleanupFailed));
                protocol_valid = false;
                break;
            },
            result = async { pending_write.as_mut().expect("已检查发送").await }, if pending_write.is_some() => {
                pending_write.take();
                if let Err(error) = result {
                    failure.get_or_insert_with(|| Arc::new(error));
                    protocol_valid = false;
                    break;
                }
            },
            command = call.channels.commands.recv(), if terminal.is_none() && failure.is_none() && pending_write.is_none() => {
                let control = match command {
                    Some(handles::Command::Input(bytes)) => SessionControl::Input {
                        protocol_version: session::SESSION_PROTOCOL_VERSION, session_id: call.request.session_id.clone(), bytes },
                    Some(handles::Command::Eof) => SessionControl::Eof {
                        protocol_version: session::SESSION_PROTOCOL_VERSION, session_id: call.request.session_id.clone() },
                    None => { call.cancel.cancel(); continue; }
                };
                match transport::frame(&control, session::SESSION_FRAME_LIMIT) {
                    Ok(bytes) => pending_write = Some(write(input.clone(), bytes, deadline)),
                    Err(error) => { failure = Some(Arc::new(error)); protocol_valid = false; break; }
                }
            },
            permit = call.channels.output.reserve(), if pending_output.is_some() => {
                match permit {
                    Ok(permit) => permit.send(pending_output.take().expect("已检查输出")),
                    Err(_) => { pending_output.take(); call.cancel.cancel(); }
                }
            },
            result = reader.next(process, session::SESSION_FINISH_LIMIT), if pending_output.is_none() => {
                let bytes = match result {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => break,
                    Err(error) => { failure.get_or_insert_with(|| Arc::new(error)); protocol_valid = false; break; }
                };
                let event: SessionEvent = match serde_json::from_slice(&bytes) {
                    Ok(event) => event,
                    Err(_) => { failure.get_or_insert_with(|| Arc::new(Error::Dependency("会话事件协议无效".into()))); protocol_valid = false; break; }
                };
                if event.validate().is_err() || event.session_id() != call.request.session_id
                    || event.sequence() != expected || terminal.is_some()
                {
                    failure.get_or_insert_with(|| Arc::new(Error::Dependency("会话事件关联、序号或终态无效".into())));
                    protocol_valid = false;
                    break;
                }
                expected = match expected.checked_add(1) {
                    Some(next) => next,
                    None => { protocol_valid = false; break; }
                };
                events += 1;
                if events > handles::MESSAGE_LIMIT {
                    failure.get_or_insert_with(|| Arc::new(Error::TooLarge)); protocol_valid = false; break;
                }
                match event {
                    SessionEvent::Output { sequence, stream, bytes: payload, .. } => {
                        output_bytes = match output_bytes.checked_add(payload.len() as u64) {
                            Some(total) if total <= handles::OUTPUT_LIMIT && bytes.len() <= session::SESSION_FRAME_LIMIT => total,
                            _ => { failure.get_or_insert_with(|| Arc::new(Error::TooLarge)); protocol_valid = false; break; }
                        };
                        if failure.is_none() {
                            pending_output = Some(SessionChunk { sequence, stream: match stream {
                                session::SessionStream::Stdout => SessionStream::Stdout,
                                session::SessionStream::Stderr => SessionStream::Stderr }, bytes: payload });
                        }
                    }
                    SessionEvent::Finished { sequence, outcome, .. } => {
                        call.channels.revoked.cancel();
                        call.channels.commands.close();
                        pending_write.take();
                        let until = (Instant::now() + transport::EXIT).min(stop_at.unwrap_or(Instant::now() + transport::EXIT));
                        exit_at = Some(until);
                        terminal = Some((sequence, outcome));
                        let input = input.clone();
                        pending_write = Some(Box::pin(async move {
                            // 已退出进程会撤销输入；Closed 本身不否定已经收到的终态。
                            let _ = tokio::time::timeout_at(until, input.close()).await.map_err(|_| Error::Timeout)?;
                            Ok(())
                        }));
                    }
                }
            },
        }
    }
    call.channels.revoked.cancel();
    if terminal.is_none() || !protocol_valid {
        process.cancel();
    }
    let end = if let Some(until) = exit_at {
        match tokio::time::timeout_at(until, process.wait()).await {
            Ok(end) => end,
            Err(_) => {
                process.cancel();
                protocol_valid = false;
                process.wait().await
            }
        }
    } else {
        process.wait().await
    };
    let (process_exited, zero) = match end {
        Ok(exit) => (true, exit.status.success()),
        Err(deviceforge_tool_process::Error::CleanupFailed { .. }) => (false, false),
        Err(_) => (true, false),
    };
    if !protocol_valid || terminal.is_none() || !zero {
        failure.get_or_insert_with(|| Arc::new(Error::CleanupFailed));
    }
    let (sequence, outcome, outputs, cleanup) = if let Some((sequence, outcome)) = terminal {
        let cleanup = if !protocol_valid || !zero {
            SessionCleanup::Unconfirmed
        } else if outcome.cleanup == CleanupOutcome::Complete {
            SessionCleanup::Complete
        } else {
            SessionCleanup::Failed
        };
        if cleanup != SessionCleanup::Complete {
            failure.get_or_insert_with(|| Arc::new(Error::CleanupFailed));
        }
        (
            Some(sequence),
            Some(SessionOutcome {
                result: outcome.result,
                error: outcome.error,
                artifacts: Vec::new(),
            }),
            outcome.outputs,
            cleanup,
        )
    } else {
        (None, None, Vec::new(), SessionCleanup::Unconfirmed)
    };
    (
        SessionExit {
            sequence,
            outcome,
            cleanup,
            process_exited,
            failure,
        },
        outputs,
    )
}
