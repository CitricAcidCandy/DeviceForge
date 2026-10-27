//! 显式协议 6 的固定 Ready/Start、反向服务和合作清理；不改变旧运行入口。
mod client;
mod wire;
use crate::{Execution, InvocationContext};
use apk_plugin_sdk::{
    Request, Response,
    cooperative::{CleanupOutcome, CooperativeResponse},
    services::*,
};
use client::Outbound;
pub use client::{ServiceClient, ServiceHandle};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, BufReader},
    sync::{mpsc, oneshot},
    time::Instant,
};

pub async fn serve_once_with_services<F, Fut>(handler: F) -> Result<(), String>
where
    F: FnOnce(Request, InvocationContext, ServiceClient) -> Fut,
    Fut: Future<Output = Execution>,
{
    crate::stdio::prepare()?;
    serve_io_with_services(tokio::io::stdin(), tokio::io::stdout(), handler).await
}

pub async fn serve_io_with_services<R, W, F, Fut>(
    reader: R,
    mut writer: W,
    handler: F,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(Request, InvocationContext, ServiceClient) -> Fut,
    Fut: Future<Output = Execution>,
{
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    let handshake_deadline = Instant::now() + Duration::from_secs(5);
    let (request, context) = tokio::time::timeout_at(handshake_deadline, async {
        let bytes = wire::line(&mut reader, &mut buffer).await?;
        if bytes.len() > 512 * 1024 {
            return Err("服务请求超过 512 KiB".to_owned());
        }
        let request: Request = serde_json::from_slice(&bytes).map_err(|_| "服务请求无效")?;
        let origin = Instant::now();
        let ready = ServiceFrame::Ready {
            protocol_version: 6,
            request_id: request.request_id.clone(),
        };
        ready.validate(&request.request_id).map_err(str::to_owned)?;
        if request.protocol_version != 6 {
            return Err("服务运行入口要求显式协议 6".into());
        }
        wire::write(&mut writer, &ready, handshake_deadline).await?;
        let bytes = wire::line(&mut reader, &mut buffer).await?;
        if bytes.len() > 4096 {
            return Err("服务握手帧超过 4 KiB".into());
        }
        let frame: ServiceFrame = serde_json::from_slice(&bytes).map_err(|_| "服务启动帧无效")?;
        frame.validate(&request.request_id).map_err(str::to_owned)?;
        let remaining = match frame {
            ServiceFrame::Start {
                remaining_timeout_ns,
                ..
            } => remaining_timeout_ns,
            ServiceFrame::Cancel { .. } => 0,
            _ => return Err("服务启动阶段收到非法帧".into()),
        };
        Ok((request, InvocationContext::from_start(origin, remaining)?))
    })
    .await
    .map_err(|_| "服务握手超过固定五秒期限")??;
    let id = request.request_id.clone();
    let cancel = context.cancellation();
    let deadline = Instant::from_std(context.deadline());
    let (sender, mut receiver) = mpsc::channel(8);
    let client = ServiceClient {
        sender,
        context: context.clone(),
        sequence: Arc::new(AtomicU64::new(1)),
    };
    let mut pending = BTreeMap::<String, oneshot::Sender<ServiceOutcome>>::new();
    let work = async {
        match context.check() {
            Ok(()) => handler(request, context.clone(), client).await,
            Err(error) => Execution::complete(Err(error.to_string())),
        }
    };
    tokio::pin!(work);
    let mut transport_failed = false;
    let mut received_bytes = 0usize;
    let mut calls = 0usize;
    let (mut execution, interrupted) = loop {
        tokio::select! { biased;
            _ = tokio::time::sleep_until(deadline) => break (None, Some("服务调用到期".to_owned())),
            _ = cancel.cancelled() => break (None, Some("服务调用已取消".to_owned())),
            bytes = wire::line(&mut reader, &mut buffer) => {
                let frame = bytes.and_then(|bytes| {
                    received_bytes += bytes.len();
                    if received_bytes > 16 * 1024 * 1024 { return Err("服务累计响应超过 16 MiB".into()); }
                    serde_json::from_slice::<ServiceFrame>(&bytes).map_err(|_| "服务响应帧无效".into())
                });
                let frame = match frame { Ok(frame) if frame.validate(&id).is_ok() => frame, _ => {
                    transport_failed = true; break (None, Some("服务输入流失败".to_owned()));
                }};
                match frame {
                    ServiceFrame::Cancel { .. } => break (None, Some("宿主取消服务调用".to_owned())),
                    ServiceFrame::ServiceResult { call_id, outcome, .. } => {
                        match pending.remove(&call_id) { Some(reply) => { let _ = reply.send(outcome); },
                            None => { transport_failed = true; break (None, Some("服务结果身份未知或重复".to_owned())); } }
                    },
                    _ => { transport_failed = true; break (None, Some("服务运行阶段收到非法帧".to_owned())); }
                }
            },
            Some(outbound) = receiver.recv() => {
                let frame = match outbound {
                    Outbound::Call { id: call_id, service, input, reply } => {
                        calls += 1;
                        if pending.len() >= 4 || calls > 1024 {
                            let _ = reply.send(ServiceOutcome::Failed { error: ServiceFailure { code: "conflict".into(), message: "服务子调用容量已满".into() } });
                            continue;
                        }
                        pending.insert(call_id.clone(), reply);
                        ServiceFrame::ServiceCall { protocol_version: 6, request_id: id.clone(), call_id, service, input }
                    },
                    Outbound::Cancel(call_id) => {
                        if !pending.contains_key(&call_id) { continue; }
                        ServiceFrame::ServiceCancel { protocol_version: 6, request_id: id.clone(), call_id }
                    },
                };
                if wire::write(&mut writer, &frame, deadline).await.is_err() {
                    transport_failed = true; break (None, Some("服务输出流失败".to_owned()));
                }
            },
            execution = &mut work => break (Some(execution), None),
        }
    };
    let grace = Instant::now() + Duration::from_millis(1250);
    cancel.cancel();
    receiver.close();
    if !transport_failed {
        for call_id in pending.keys() {
            if wire::write(
                &mut writer,
                &ServiceFrame::ServiceCancel {
                    protocol_version: 6,
                    request_id: id.clone(),
                    call_id: call_id.clone(),
                },
                grace,
            )
            .await
            .is_err()
            {
                transport_failed = true;
                break;
            }
        }
    }
    pending.clear();
    if execution.is_none() {
        execution = tokio::time::timeout_at(grace, &mut work).await.ok();
    }
    let mut execution = execution.unwrap_or(Execution {
        outcome: Err("服务处理器未确认清理".into()),
        cleanup: CleanupOutcome::Failed,
    });
    if let Some(reason) = interrupted {
        execution.outcome = Err(reason);
    }
    if transport_failed {
        return Err("服务传输失效，不能向半帧追加清理终态".into());
    }
    let (result, error, outputs) = match execution.outcome {
        Ok(output) => (Some(output.value), None, output.artifacts),
        Err(error) => (
            None,
            Some(if error.trim().is_empty() {
                "服务处理失败".into()
            } else {
                error
            }),
            Vec::new(),
        ),
    };
    wire::write(
        &mut writer,
        &ServiceFrame::Finished {
            protocol_version: 6,
            request_id: id.clone(),
            execution: CooperativeResponse {
                response: Response {
                    protocol_version: 6,
                    request_id: id,
                    result,
                    error,
                    outputs,
                },
                cleanup: execution.cleanup,
            },
        },
        grace,
    )
    .await
}
