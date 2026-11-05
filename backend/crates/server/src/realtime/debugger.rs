//! 调试命名空间只调度既有服务；状态变化和原期限驱动，无空闲轮询。

use super::{
    access::PhysicalConnection,
    outbox::{Lane, Outbox},
    retry::BusyRetry,
    wire,
};
use apk_application::{Application, debugger::*};
use serde::Serialize;
use serde_json::Value;
use socketioxide::extract::{AckSender, SocketRef, TryData};
use std::{
    sync::{Arc, Mutex, TryLockError},
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Control {
    lease: Option<BridgeLease>,
    free: usize,
}

struct Connection {
    service: Arc<DebuggerService>,
    owner: String,
    control: Mutex<Control>,
    changed: Notify,
    unlocked: Notify,
    stopped: CancellationToken,
    outbox: Arc<Outbox>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(control) = self.control.get_mut()
            && let Some(lease) = &control.lease
        {
            let _ = self.service.realtime_detach(lease);
        }
    }
}

#[derive(Serialize)]
struct ReadyAccepted {
    accepted: bool,
    limit: usize,
}

fn no_instance() -> DebuggerError {
    DebuggerError {
        code: ErrorCode::NotFound,
        message: "请先通过 bridge:open 登记或恢复浏览器实例".into(),
    }
}

impl Connection {
    fn use_control<T>(&self, work: impl FnOnce(&mut Control) -> Result<T>) -> Result<T> {
        if self.stopped.is_cancelled() {
            return Err(DebuggerError {
                code: ErrorCode::WrongInstance,
                message: "调试连接已关闭，旧回调不能登记新实例".into(),
            });
        }
        let mut control = self.control.try_lock().map_err(|error| DebuggerError {
            code: if matches!(error, TryLockError::WouldBlock) {
                ErrorCode::Busy
            } else {
                ErrorCode::Internal
            },
            message: "实时调试连接暂时无法处理本次消息".into(),
        })?;
        if self.stopped.is_cancelled() {
            return Err(DebuggerError {
                code: ErrorCode::WrongInstance,
                message: "调试连接已撤销，未登记旧回调".into(),
            });
        }
        let result = work(&mut control);
        drop(control);
        if !matches!(&result, Err(error) if error.code == ErrorCode::Busy) {
            self.unlocked.notify_waiters();
        }
        result
    }

    fn disconnect(&self) {
        self.stopped.cancel();
        if let Ok(control) = self.control.lock()
            && let Some(lease) = &control.lease
        {
            let _ = self.service.realtime_detach(lease);
        }
    }
}

pub(super) fn connected(socket: SocketRef, service: Arc<DebuggerService>, app: Arc<Application>) {
    let Some(physical) = PhysicalConnection::get(&socket) else {
        wire::disconnect(&socket, Lane::Debugger);
        return;
    };
    if !physical.inner.attach(Lane::Debugger) {
        wire::disconnect(&socket, Lane::Debugger);
        return;
    }
    let connection = Arc::new(Connection {
        service,
        owner: uuid::Uuid::new_v4().to_string(),
        control: Mutex::new(Control::default()),
        changed: Notify::new(),
        unlocked: Notify::new(),
        stopped: CancellationToken::new(),
        outbox: physical.inner.outbox.clone(),
    });
    let current = connection.clone();
    socket.on_disconnect(move |socket: SocketRef| async move {
        current.disconnect();
        wire::detached(&socket, Lane::Debugger).await;
    });

    let current = connection.clone();
    socket.on(
        "bridge:open",
        move |socket: SocketRef, data: TryData<BridgeOpen>, ack: AckSender| async move {
            let result = wire::parse(data).and_then(|input| {
                current.use_control(|control| {
                    let (lease, opened) = current.service.realtime_open(&current.owner, input)?;
                    control.lease = Some(lease);
                    control.free = 0;
                    Ok(opened)
                })
            });
            wire::ack(&socket, &current.outbox, ack, "bridge:open", result).await;
            current.changed.notify_one();
        },
    );

    let current = connection.clone();
    socket.on(
        "bridge:directory",
        move |socket: SocketRef, data: TryData<BridgeDirectory>, ack: AckSender| async move {
            let result = wire::parse(data).and_then(|input| {
                current.use_control(|control| {
                    current
                        .service
                        .realtime_directory(control.lease.as_ref().ok_or_else(no_instance)?, input)
                })
            });
            wire::ack(&socket, &current.outbox, ack, "bridge:directory", result).await;
        },
    );

    let current = connection.clone();
    socket.on(
        "bridge:ready",
        move |socket: SocketRef, data: TryData<BridgeReady>, ack: AckSender| async move {
            let result = wire::parse(data).and_then(|input| {
                current.use_control(|control| {
                    let lease = control.lease.as_ref().ok_or_else(no_instance)?;
                    if input.limit > 4 || input.instance_id != lease.instance_id {
                        return Err(wire::invalid("空槽数必须为 0 到 4 且实例必须为当前实例"));
                    }
                    current.service.realtime_status(lease)?;
                    control.free = input.limit;
                    Ok(ReadyAccepted {
                        accepted: true,
                        limit: input.limit,
                    })
                })
            });
            wire::ack(&socket, &current.outbox, ack, "bridge:ready", result).await;
            current.changed.notify_one();
        },
    );

    let current = connection.clone();
    socket.on(
        "bridge:ack",
        move |socket: SocketRef, data: TryData<BridgeAck>, ack: AckSender| async move {
            let result = wire::parse(data).and_then(|input| {
                current.use_control(|control| {
                    current.service.realtime_acknowledge(
                        control.lease.as_ref().ok_or_else(no_instance)?,
                        input,
                    )
                })
            });
            wire::ack(&socket, &current.outbox, ack, "bridge:ack", result).await;
        },
    );

    let current = connection.clone();
    socket.on(
        "bridge:close",
        move |socket: SocketRef, data: TryData<BridgeClose>, ack: AckSender| async move {
            let result = wire::parse(data).and_then(|input| {
                current.use_control(|control| {
                    current.service.realtime_close(
                        control.lease.as_ref().ok_or_else(no_instance)?,
                        &input.instance_id,
                    )?;
                    control.lease = None;
                    control.free = 0;
                    Ok(serde_json::json!({"disconnected": true}))
                })
            });
            wire::ack(&socket, &current.outbox, ack, "bridge:close", result).await;
            current.changed.notify_one();
        },
    );
    let _ = app;
    physical
        .inner
        .spawn(pump(socket, connection, physical.inner.stopping.clone()));
}

async fn pump(socket: SocketRef, connection: Arc<Connection>, shutdown: CancellationToken) {
    let opened_by = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut status: Option<Value> = None;
    let mut deadline = Some(opened_by);
    let mut busy = BusyRetry::default();
    loop {
        let changed = connection.service.realtime_changed();
        let ready = connection.changed.notified();
        let capacity = connection.outbox.capacity_changed();
        let service_unlocked = connection.service.realtime_unlocked();
        let control_unlocked = connection.unlocked.notified();
        tokio::pin!(changed, ready, capacity, service_unlocked, control_unlocked);
        changed.as_mut().enable();
        ready.as_mut().enable();
        capacity.as_mut().enable();
        service_unlocked.as_mut().enable();
        control_unlocked.as_mut().enable();
        // 未取得队列资格时不能领取命令，否则容量拒绝会消耗 Delivered 状态。
        let Some(reservation) = connection.outbox.reserve_debugger() else {
            tokio::select! {
                biased;
                _ = connection.stopped.cancelled() => break,
                _ = shutdown.cancelled() => break,
                _ = capacity => {},
                _ = changed => {},
                _ = ready => {},
            }
            continue;
        };
        let next = connection.use_control(|control| {
            let Some(lease) = &control.lease else {
                return Ok(None);
            };
            let (batch, remaining) = connection.service.realtime_batch(lease, control.free)?;
            control.free = control.free.saturating_sub(batch.commands.len());
            Ok(Some((batch, remaining)))
        });
        let remaining = match next {
            Ok(Some((batch, remaining))) => {
                busy.reset();
                deadline = if remaining == Duration::MAX {
                    None
                } else {
                    Some(tokio::time::Instant::now() + remaining)
                };
                let current = serde_json::json!({"instance_id":batch.instance_id, "active_sessions": batch.active_sessions, "targets": batch.targets});
                if status.as_ref() != Some(&current) || !batch.commands.is_empty() {
                    if reservation
                        .event(
                            socket.clone(),
                            "bridge:batch",
                            wire::success("bridge:batch", &batch),
                        )
                        .is_err()
                    {
                        tracing::warn!(
                            code = "realtime_backpressure",
                            "调试批次发送队列已满，动作结果保留为未确认"
                        );
                        wire::disconnect(&socket, Lane::Debugger);
                        break;
                    }
                    status = Some(current);
                } else {
                    drop(reservation);
                }
                remaining
            }
            Ok(None) => {
                drop(reservation);
                status = None;
                // 显式关闭后允许停留在命名空间；首次登记必须受五秒期限约束。
                if tokio::time::Instant::now() < opened_by {
                    opened_by.saturating_duration_since(tokio::time::Instant::now())
                } else {
                    wire::disconnect(&socket, Lane::Debugger);
                    break;
                }
            }
            Err(error) if error.code == ErrorCode::Busy => {
                drop(reservation);
                if let Some(delay) = busy.delay(tokio::time::Instant::now(), deadline) {
                    tokio::select! {
                        biased;
                        _ = connection.stopped.cancelled() => break,
                        _ = shutdown.cancelled() => break,
                        _ = service_unlocked => {},
                        _ = control_unlocked => {},
                        _ = tokio::time::sleep(delay) => {},
                    }
                } else {
                    // 原预算或短退避已用完，保留健康连接；后续真实状态变化仍可继续独立新工作。
                    tokio::select! {
                        biased;
                        _ = connection.stopped.cancelled() => break,
                        _ = shutdown.cancelled() => break,
                        _ = service_unlocked => {},
                        _ = control_unlocked => {},
                        _ = changed => {},
                        _ = ready => {},
                    }
                    busy.reset();
                }
                continue;
            }
            Err(error) => {
                let value = wire::debug_failure(error);
                let _ = reservation.event(socket.clone(), "bridge:batch", value);
                wire::disconnect(&socket, Lane::Debugger);
                break;
            }
        };
        tokio::select! {
            biased;
            _ = connection.stopped.cancelled() => break,
            _ = shutdown.cancelled() => break,
            _ = changed => {},
            _ = ready => {},
            _ = wait_deadline(remaining) => {},
        }
    }
    connection.disconnect();
}

async fn wait_deadline(remaining: Duration) {
    if remaining == Duration::MAX {
        std::future::pending::<()>().await;
    } else {
        tokio::time::sleep(remaining).await;
    }
}
