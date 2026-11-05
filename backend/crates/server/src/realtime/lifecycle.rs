//! 每条物理连接独占 SocketIo 关闭句柄；关闭不会触及其他浏览器连接。

use super::{
    outbox::{Lane, Outbox},
    types::MAX_CONNECTIONS,
};
use socketioxide::{SocketError, SocketIo, extract::SocketRef};
use std::{
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct Lifecycle {
    pub(super) slots: Arc<Semaphore>,
    shutdown: CancellationToken,
    stopping: CancellationToken,
    started: AtomicBool,
    connections: Mutex<Vec<Weak<ConnectionResources>>>,
    tasks: TaskTracker,
}

impl Lifecycle {
    pub(crate) fn new(shutdown: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            shutdown,
            stopping: CancellationToken::new(),
            started: AtomicBool::new(false),
            connections: Mutex::new(Vec::new()),
            tasks: TaskTracker::new(),
        })
    }

    pub(super) fn admit(self: &Arc<Self>) -> Option<Arc<ConnectionResources>> {
        let mut connections = self.connections.lock().ok()?;
        if self.shutdown.is_cancelled() || self.stopping.is_cancelled() {
            return None;
        }
        let permit = self.slots.clone().try_acquire_owned().ok()?;
        connections.retain(|entry| entry.strong_count() != 0);
        let resources = Arc::new_cyclic(|weak| ConnectionResources {
            permit: Mutex::new(Some(permit)),
            outbox: Outbox::new(weak.clone()),
            runtime: Arc::downgrade(self),
            state: Mutex::new(ConnectionState::default()),
            stopping: CancellationToken::new(),
            closed: CancellationToken::new(),
            transport_closed: CancellationToken::new(),
        });
        connections.push(Arc::downgrade(&resources));
        Some(resources)
    }

    pub(super) fn start(self: &Arc<Self>, app: &apk_application::Application) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        app.track_shutdown_task(async move {
            if let Some(runtime) = weak.upgrade() {
                runtime.close().await;
            }
        });
    }

    pub(super) fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        self.tasks.spawn(future);
    }

    /// 停止准入后先关闭物理传输，再等待本模块的发送、订阅和回收任务。
    pub(crate) async fn close(&self) {
        self.stopping.cancel();
        self.slots.close();
        let resources: Vec<_> = self
            .connections
            .lock()
            .map(|connections| connections.iter().filter_map(Weak::upgrade).collect())
            .unwrap_or_default();
        futures_util::future::join_all(resources.iter().map(|entry| entry.close())).await;
        self.tasks.close();
        if tokio::time::timeout(CLOSE_TIMEOUT, self.tasks.wait())
            .await
            .is_err()
        {
            tracing::warn!(
                code = "realtime_drain_unconfirmed",
                "实时任务排空超时，保留未确认诊断"
            );
        }
    }
}

#[derive(Default)]
struct ConnectionState {
    io: Option<SocketIo>,
    namespaces: u8,
    had_namespace: bool,
    transport_tracked: bool,
    closing_namespaces: u8,
    closing: bool,
}

pub(super) struct ConnectionResources {
    permit: Mutex<Option<OwnedSemaphorePermit>>,
    pub(super) outbox: Arc<Outbox>,
    runtime: Weak<Lifecycle>,
    state: Mutex<ConnectionState>,
    pub(super) stopping: CancellationToken,
    closed: CancellationToken,
    transport_closed: CancellationToken,
}

/// 与升级请求及库保存的请求部分共同持有；最后一份释放才确认未登记传输真正结束。
pub(super) struct TransportGuard(Weak<ConnectionResources>);

impl Drop for TransportGuard {
    fn drop(&mut self) {
        if let Some(resources) = self.0.upgrade() {
            resources.transport_closed.cancel();
            resources.stopping.cancel();
            // 此析构可能发生在队列清理中，不能重新取得发送队列锁。
            if let Ok(mut permit) = resources.permit.lock() {
                permit.take();
            }
        }
    }
}

impl ConnectionResources {
    pub(super) fn track_transport(self: &Arc<Self>) -> Arc<TransportGuard> {
        if let Ok(mut state) = self.state.lock() {
            state.transport_tracked = true;
        }
        Arc::new(TransportGuard(Arc::downgrade(self)))
    }
    pub(super) fn bind(&self, io: SocketIo) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.closing || state.io.is_some() {
            return false;
        }
        state.io = Some(io);
        true
    }

    pub(super) fn attach(&self, lane: Lane) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.closing || state.closing_namespaces & (1 << lane as usize) != 0 {
            return false;
        }
        state.namespaces |= 1 << lane as usize;
        state.had_namespace = true;
        self.outbox.open_lane(lane);
        true
    }

    pub(super) fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.spawn(future);
        }
    }

    /// 此回调在依赖移除命名空间之前执行，最后一个消费者离开时仍可真实关闭物理传输。
    pub(super) async fn detached(&self, lane: Lane) {
        let last = if let Ok(mut state) = self.state.lock() {
            state.namespaces &= !(1 << lane as usize);
            state.closing_namespaces &= !(1 << lane as usize);
            state.namespaces == 0
        } else {
            true
        };
        if last {
            self.close_inner(true).await;
        }
    }

    pub(super) fn request_disconnect(self: &Arc<Self>, socket: SocketRef, lane: Lane) {
        // 旧命名空间的迟到发送失败不能停止同一物理连接上已经重新登记的新消费者。
        if !socket.connected() {
            return;
        }
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let mask = 1 << lane as usize;
            if state.closing || state.closing_namespaces & mask != 0 {
                return;
            }
            state.closing_namespaces |= mask;
        }
        self.outbox.stop_lane(lane);
        let resources = self.clone();
        self.spawn(async move {
            let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
            loop {
                match socket.clone().disconnect() {
                    Ok(()) | Err(SocketError::Closed) => return,
                    Err(SocketError::InternalChannelFull)
                        if tokio::time::Instant::now() < deadline =>
                    {
                        tokio::select! {
                            _ = resources.stopping.cancelled() => return,
                            _ = tokio::time::sleep(Duration::from_millis(5)) => {},
                        }
                    }
                    Err(_) => break,
                }
            }
            tracing::warn!(
                code = "realtime_disconnect_backpressure",
                "命名空间关闭受物理发送阻塞，关闭当前物理连接"
            );
            resources.close().await;
        });
    }

    pub(super) async fn close(&self) {
        self.close_inner(false).await;
    }

    async fn close_inner(&self, only_if_idle: bool) {
        let (owns_close, io, had_namespace, transport_tracked) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            // 最后一个消费者清理与新消费者登记共用此排序点，不能用锁外的旧快照关闭新订阅。
            if only_if_idle && state.namespaces != 0 {
                return;
            }
            if state.closing {
                (false, None, false, false)
            } else {
                state.closing = true;
                self.stopping.cancel();
                self.outbox.stop();
                (
                    true,
                    state.io.take(),
                    state.had_namespace,
                    state.transport_tracked,
                )
            }
        };
        if !owns_close {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, self.closed.cancelled()).await;
            return;
        }
        let bound_transport = io.is_some();
        if let Some(io) = io {
            if tokio::time::timeout(CLOSE_TIMEOUT, io.close())
                .await
                .is_err()
            {
                tracing::warn!(
                    code = "realtime_transport_close_unconfirmed",
                    "当前物理连接关闭未确认，许可不提前释放"
                );
                return;
            }
        }
        // 空命名空间的库 close 不能证明 Engine.IO 已结束，等待真实请求归属释放。
        if bound_transport
            && !had_namespace
            && transport_tracked
            && tokio::time::timeout(CLOSE_TIMEOUT, self.transport_closed.cancelled())
                .await
                .is_err()
        {
            tracing::warn!(
                code = "realtime_transport_close_unconfirmed",
                "未登记传输关闭未确认，保留其物理许可"
            );
            return;
        }
        if let Ok(mut permit) = self.permit.lock() {
            permit.take();
        }
        self.closed.cancel();
    }
}
