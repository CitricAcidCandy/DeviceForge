use super::SessionIoError;
use crate::{ContextError, InvocationContext};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// 首次失败在通知取消之前固定，清理等待不改变原始业务失败原因。
pub(super) struct State {
    pub context: InvocationContext,
    pub output_closed: CancellationToken,
    failure: Mutex<Option<String>>,
}

impl State {
    pub fn new(context: InvocationContext) -> Arc<Self> {
        Arc::new(Self {
            context,
            output_closed: CancellationToken::new(),
            failure: Mutex::new(None),
        })
    }

    pub fn fail(&self, message: impl Into<String>) {
        let mut failure = self
            .failure
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if failure.is_none() {
            *failure = Some(message.into());
        }
        drop(failure);
        self.context.cancellation().cancel();
        self.output_closed.cancel();
    }

    pub fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn check(&self) -> Result<(), SessionIoError> {
        match self.context.check() {
            Ok(()) => Ok(()),
            Err(ContextError::Timeout) => {
                self.fail(ContextError::Timeout.to_string());
                Err(SessionIoError::Timeout)
            }
            Err(ContextError::Cancelled) => Err(SessionIoError::Cancelled),
        }
    }

    pub fn close_output(&self) {
        self.output_closed.cancel();
    }
}
