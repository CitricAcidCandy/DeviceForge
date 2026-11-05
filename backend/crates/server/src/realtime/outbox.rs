//! 分 lane 预留入队额度；命令先取得发送资格，任务通知仅合并最新修订。

use super::{
    lifecycle::ConnectionResources,
    types::{MAX_MESSAGE_BYTES, MAX_PENDING_BYTES},
};
use serde_json::Value;
use socketioxide::{
    SendError, SocketError,
    extract::{AckSender, SocketRef},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lane {
    Debugger = 0,
    Tasks = 1,
}

// 两类额度之和不超过原 8 包、8 MiB；额度包含在途包和已取得但尚未提交的资格。
const PACKETS: [usize; 2] = [6, 2];
const BYTES: [usize; 2] = [MAX_PENDING_BYTES - 1024 * 1024, 1024 * 1024];

pub(super) struct Queue<T> {
    lanes: [VecDeque<(T, usize)>; 2],
    used: [(usize, usize); 2],
    next: usize,
    stopped: [bool; 2],
    draining: bool,
}

impl<T> Default for Queue<T> {
    fn default() -> Self {
        Self {
            lanes: Default::default(),
            used: [(0, 0); 2],
            next: 0,
            stopped: [false; 2],
            draining: false,
        }
    }
}

impl<T> Queue<T> {
    pub(super) fn reserve(&mut self, lane: Lane, bytes: usize) -> bool {
        let index = lane as usize;
        let (count, size) = self.used[index];
        if self.stopped[index]
            || count >= PACKETS[index]
            || size.saturating_add(bytes) > BYTES[index]
        {
            return false;
        }
        self.used[index] = (count + 1, size + bytes);
        true
    }

    pub(super) fn release(&mut self, lane: Lane, bytes: usize) {
        let usage = &mut self.used[lane as usize];
        usage.0 = usage.0.saturating_sub(1);
        usage.1 = usage.1.saturating_sub(bytes);
    }

    pub(super) fn push(&mut self, lane: Lane, value: T, bytes: usize) {
        self.lanes[lane as usize].push_back((value, bytes));
    }

    pub(super) fn pop(&mut self) -> Option<(Lane, T, usize)> {
        let index = if self.lanes[self.next].is_empty() {
            1 - self.next
        } else {
            self.next
        };
        let (value, bytes) = self.lanes[index].pop_front()?;
        self.next = 1 - index;
        Some((
            if index == 0 {
                Lane::Debugger
            } else {
                Lane::Tasks
            },
            value,
            bytes,
        ))
    }

    fn clear(&mut self, lane: Lane) -> usize {
        self.stopped[lane as usize] = true;
        let count = self.lanes[lane as usize].len();
        while let Some((_, bytes)) = self.lanes[lane as usize].pop_front() {
            self.release(lane, bytes);
        }
        count
    }
}

enum Message {
    Event(&'static str),
    Ack(AckSender),
}

struct Pending {
    socket: SocketRef,
    message: Message,
    event: &'static str,
    value: Value,
}

pub(super) struct Outbox {
    queue: Mutex<Queue<Pending>>,
    resources: Weak<ConnectionResources>,
    available: Notify,
}

pub(super) struct Reservation {
    outbox: Arc<Outbox>,
    active: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.active {
            self.outbox.release(Lane::Debugger, MAX_MESSAGE_BYTES);
        }
    }
}

impl Reservation {
    pub(super) fn event(
        mut self,
        socket: SocketRef,
        event: &'static str,
        value: Value,
    ) -> Result<(), ()> {
        let bytes = message_bytes(&value)?;
        let mut queue = self.outbox.queue.lock().map_err(|_| ())?;
        if queue.stopped[Lane::Debugger as usize] {
            return Err(());
        }
        queue.used[Lane::Debugger as usize].1 -= MAX_MESSAGE_BYTES - bytes;
        queue.push(
            Lane::Debugger,
            Pending {
                socket,
                message: Message::Event(event),
                event,
                value,
            },
            bytes,
        );
        self.active = false;
        drop(queue);
        self.outbox.kick();
        Ok(())
    }
}

pub(super) fn message_bytes(value: &Value) -> Result<usize, ()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ())?.len();
    if bytes.saturating_add(128) > MAX_MESSAGE_BYTES {
        return Err(());
    }
    Ok(bytes)
}

impl Outbox {
    pub(super) fn new(resources: Weak<ConnectionResources>) -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(Queue::default()),
            resources,
            available: Notify::new(),
        })
    }

    pub(super) fn reserve_debugger(self: &Arc<Self>) -> Option<Reservation> {
        if !self
            .queue
            .lock()
            .ok()?
            .reserve(Lane::Debugger, MAX_MESSAGE_BYTES)
        {
            return None;
        }
        Some(Reservation {
            outbox: self.clone(),
            active: true,
        })
    }

    pub(super) fn capacity_changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.available.notified()
    }

    fn release(&self, lane: Lane, bytes: usize) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.release(lane, bytes);
        }
        self.available.notify_waiters();
    }

    pub(super) fn stop_lane(&self, lane: Lane) {
        if let Ok(mut queue) = self.queue.lock() {
            let count = queue.clear(lane);
            if count != 0 {
                tracing::warn!(
                    ?lane,
                    pending = count,
                    code = "realtime_unsent_unconfirmed",
                    "连接关闭时尚有未确认消息；命令不重放，结果保留原服务历史"
                );
            }
        }
        self.available.notify_waiters();
    }

    pub(super) fn stop(&self) {
        self.stop_lane(Lane::Debugger);
        self.stop_lane(Lane::Tasks);
    }

    pub(super) fn open_lane(&self, lane: Lane) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.stopped[lane as usize] = false;
        }
    }

    pub(super) fn event(
        self: &Arc<Self>,
        socket: SocketRef,
        lane: Lane,
        event: &'static str,
        value: Value,
    ) -> Result<(), ()> {
        let mut pending = Pending {
            socket,
            message: Message::Event(event),
            event,
            value,
        };
        let mut bytes = message_bytes(&pending.value)?;
        let mut queue = self.queue.lock().map_err(|_| ())?;
        if queue.stopped[lane as usize] {
            return Err(());
        }
        if lane == Lane::Tasks
            && let Some((previous, previous_bytes)) = queue.lanes[Lane::Tasks as usize].back()
        {
            merge_task_notice(&previous.value, &mut pending.value);
            bytes = message_bytes(&pending.value)?;
            let previous_bytes = *previous_bytes;
            let usage = queue.used[Lane::Tasks as usize].1 - previous_bytes + bytes;
            if usage > BYTES[Lane::Tasks as usize] {
                return Err(());
            }
            queue.used[Lane::Tasks as usize].1 = usage;
            *queue.lanes[Lane::Tasks as usize].back_mut().ok_or(())? = (pending, bytes);
        } else {
            if !queue.reserve(lane, bytes) {
                return Err(());
            }
            queue.push(lane, pending, bytes);
        }
        drop(queue);
        self.kick();
        Ok(())
    }

    pub(super) async fn ack(
        self: &Arc<Self>,
        socket: SocketRef,
        sender: AckSender,
        event: &'static str,
        value: Value,
    ) -> Result<(), ()> {
        let bytes = message_bytes(&value)?;
        let resources = self.resources.upgrade().ok_or(())?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let available = self.available.notified();
            tokio::pin!(available);
            available.as_mut().enable();
            {
                let mut queue = self.queue.lock().map_err(|_| ())?;
                if queue.stopped[Lane::Debugger as usize] {
                    return Err(());
                }
                if queue.reserve(Lane::Debugger, bytes) {
                    queue.push(
                        Lane::Debugger,
                        Pending {
                            socket,
                            message: Message::Ack(sender),
                            event,
                            value,
                        },
                        bytes,
                    );
                    drop(queue);
                    self.kick();
                    return Ok(());
                }
            }
            tokio::select! {
                biased;
                _ = resources.stopping.cancelled() => return Err(()),
                _ = tokio::time::sleep_until(deadline) => return Err(()),
                _ = available => {},
            }
        }
    }

    fn kick(self: &Arc<Self>) {
        let Some(resources) = self.resources.upgrade() else {
            return;
        };
        let Ok(mut queue) = self.queue.lock() else {
            return;
        };
        if queue.draining {
            return;
        }
        queue.draining = true;
        let outbox = self.clone();
        drop(queue);
        resources.spawn(async move {
            outbox.drain().await;
        });
    }

    async fn drain(&self) {
        loop {
            let pending = {
                let Ok(mut queue) = self.queue.lock() else {
                    return;
                };
                match queue.pop() {
                    Some(pending) => pending,
                    None => {
                        queue.draining = false;
                        return;
                    }
                }
            };
            let (lane, pending, bytes) = pending;
            self.send(lane, pending).await;
            self.release(lane, bytes);
        }
    }

    async fn send(&self, lane: Lane, pending: Pending) {
        if !pending.socket.connected()
            || self
                .queue
                .lock()
                .map(|queue| queue.stopped[lane as usize])
                .unwrap_or(true)
        {
            return;
        }
        let Some(resources) = self.resources.upgrade() else {
            return;
        };
        let failed = match pending.message {
            // 库的 AckSender 被 send 消费，不能伪造可重试 ACK；失败后按命令 ID 恢复既有服务结果。
            Message::Ack(sender) => sender.send(&pending.value).is_err(),
            Message::Event(event) => {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                loop {
                    if self
                        .queue
                        .lock()
                        .map(|queue| queue.stopped[lane as usize])
                        .unwrap_or(true)
                    {
                        return;
                    }
                    match pending.socket.emit(event, &pending.value) {
                        Ok(()) => return,
                        Err(SendError::Socket(SocketError::InternalChannelFull))
                            if tokio::time::Instant::now() < deadline =>
                        {
                            tokio::select! {
                                _ = resources.stopping.cancelled() => return,
                                _ = tokio::time::sleep(Duration::from_millis(5)) => {},
                            }
                        }
                        Err(_) => break true,
                    }
                }
            }
        };
        if failed {
            tracing::warn!(
                event = pending.event,
                code = "realtime_send_unconfirmed",
                "实时消息发送失败，结果保留原服务历史并有界关闭对应连接"
            );
            resources.request_disconnect(pending.socket, lane);
        }
    }
}

pub(super) fn merge_task_notice(previous: &Value, latest: &mut Value) {
    if previous.pointer("/data/reset").and_then(Value::as_bool) == Some(true)
        && let Some(data) = latest.get_mut("data").and_then(Value::as_object_mut)
    {
        data.insert("reset".into(), Value::Bool(true));
    }
}
