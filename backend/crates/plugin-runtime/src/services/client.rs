//! 有类型的服务句柄；丢弃调用 Future 会向宿主撤销对应子调用。
use super::InvocationContext;
use apk_plugin_sdk::services::{ServiceOutcome, ServiceRef};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    marker::PhantomData,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

pub(super) enum Outbound {
    Call {
        id: String,
        service: ServiceRef,
        input: serde_json::Value,
        reply: oneshot::Sender<ServiceOutcome>,
    },
    Cancel(String),
}

#[derive(Clone)]
pub struct ServiceClient {
    pub(super) sender: mpsc::Sender<Outbound>,
    pub(super) sequence: Arc<AtomicU64>,
    pub(super) context: InvocationContext,
}

pub struct ServiceHandle<I, O> {
    client: ServiceClient,
    reference: ServiceRef,
    marker: PhantomData<fn(I) -> O>,
}

impl<I, O> Clone for ServiceHandle<I, O> {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            reference: self.reference.clone(),
            marker: PhantomData,
        }
    }
}

impl ServiceClient {
    pub fn service<I: Serialize, O: DeserializeOwned>(
        &self,
        reference: ServiceRef,
    ) -> ServiceHandle<I, O> {
        ServiceHandle {
            client: self.clone(),
            reference,
            marker: PhantomData,
        }
    }
}

struct CancelOnDrop {
    id: String,
    sender: mpsc::Sender<Outbound>,
    context: InvocationContext,
    finished: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if !self.finished
            && self
                .sender
                .try_send(Outbound::Cancel(self.id.clone()))
                .is_err()
        {
            self.context.cancellation().cancel();
        }
    }
}

impl<I: Serialize, O: DeserializeOwned> ServiceHandle<I, O> {
    pub async fn call(&self, input: &I) -> Result<O, String> {
        self.reference.validate().map_err(str::to_owned)?;
        self.client.context.check().map_err(|e| e.to_string())?;
        let input = serde_json::to_value(input).map_err(|_| "服务输入序列化失败")?;
        if serde_json::to_vec(&input)
            .map_err(|_| "服务输入编码失败")?
            .len()
            > 512 * 1024
        {
            return Err("服务输入超过 512 KiB".into());
        }
        let sequence = self
            .client
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| "服务调用序号耗尽")?;
        let id = sequence.to_string();
        let (reply, receive) = oneshot::channel();
        let mut guard = CancelOnDrop {
            id: id.clone(),
            sender: self.client.sender.clone(),
            context: self.client.context.clone(),
            finished: true,
        };
        let cancel = self.client.context.cancellation();
        let deadline = tokio::time::Instant::from_std(self.client.context.deadline());
        self.client
            .sender
            .try_send(Outbound::Call {
                id,
                service: self.reference.clone(),
                input,
                reply,
            })
            .map_err(|_| "服务请求队列已满或关闭")?;
        guard.finished = false;
        let outcome = tokio::select! { biased;
            _ = tokio::time::sleep_until(deadline) => return Err("服务调用到期".into()),
            _ = cancel.cancelled() => return Err("服务调用已取消".into()),
            outcome = receive => outcome.map_err(|_| "服务结果通道关闭")?,
        };
        guard.finished = true;
        match outcome {
            ServiceOutcome::Succeeded { result } => {
                serde_json::from_value(result).map_err(|_| "服务输出不符合句柄类型".into())
            }
            ServiceOutcome::Failed { error } => Err(format!("{}：{}", error.code, error.message)),
        }
    }
}
