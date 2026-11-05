//! 任务推送只读取 watch 修订；固定合并窗口不被持续进度刷新无限延后。

use super::{TasksChanged, access::PhysicalConnection, outbox::Lane, wire};
use apk_application::Application;
use socketioxide::extract::SocketRef;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) fn connected(socket: SocketRef, app: Arc<Application>) {
    let Some(connection) = PhysicalConnection::get(&socket) else {
        wire::disconnect(&socket, Lane::Tasks);
        return;
    };
    if !connection.inner.attach(Lane::Tasks) {
        wire::disconnect(&socket, Lane::Tasks);
        return;
    }
    let stopped = CancellationToken::new();
    let disconnected = stopped.clone();
    socket.on_disconnect(move |socket: SocketRef| async move {
        disconnected.cancel();
        wire::detached(&socket, Lane::Tasks).await;
    });
    let mut changes = app.subscribe_job_changes();
    let outbox = connection.inner.outbox.clone();
    let initial = TasksChanged {
        revision: changes.borrow_and_update().to_string(),
        reset: true,
    };
    if wire::event(&socket, &outbox, Lane::Tasks, "tasks:changed", &initial).is_err() {
        wire::disconnect(&socket, Lane::Tasks);
        return;
    }
    let shutdown = connection.inner.stopping.clone();
    connection.inner.spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = stopped.cancelled() => break,
                _ = shutdown.cancelled() => break,
                changed = changes.changed() => { if changed.is_err() { break; } },
            }
            tokio::select! {
                biased;
                _ = stopped.cancelled() => break,
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
            let revision = changes.borrow_and_update().to_string();
            if wire::event(
                &socket,
                &outbox,
                Lane::Tasks,
                "tasks:changed",
                &TasksChanged {
                    revision,
                    reset: false,
                },
            )
            .is_err()
            {
                tracing::warn!(
                    code = "realtime_backpressure",
                    "任务通知发送队列已满，结束任务订阅供客户端读取快照"
                );
                wire::disconnect(&socket, Lane::Tasks);
                break;
            }
        }
    });
}
