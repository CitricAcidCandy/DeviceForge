//! 单次发现的同步裁定与有界回执；不读取数据库或持锁执行I/O。
use crate::registry::Owner;
use apk_domain::{Error, Result, devices::*};
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedSemaphorePermit};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(crate) enum Rejection {
    Cancelled,
    Timeout,
    Conflict,
    Storage,
    Dependency,
    Cleanup,
}
impl Rejection {
    pub fn from_error(error: &Error) -> Self {
        match error {
            Error::Cancelled => Self::Cancelled,
            Error::Timeout => Self::Timeout,
            Error::Conflict(_) | Error::NotFound(_) => Self::Conflict,
            Error::Storage(_) => Self::Storage,
            Error::CleanupFailed => Self::Cleanup,
            _ => Self::Dependency,
        }
    }
    pub fn error(&self) -> Error {
        match self {
            Self::Cancelled => Error::Cancelled,
            Self::Timeout => Error::Timeout,
            Self::Conflict => Error::Conflict("发现提供者、贡献或代际已撤销".into()),
            Self::Storage => Error::Storage("发现存储处理失败".into()),
            Self::Dependency => Error::Dependency("设备发现观测失败".into()),
            Self::Cleanup => Error::CleanupFailed,
        }
    }
}
pub(crate) enum Decision {
    Pending,
    Cancelled(Rejection),
    Accepted(Box<DeviceDirectory>),
}
pub(crate) struct State {
    pub decision: Decision,
    pub started: bool,
    finished: bool,
    permit: Option<OwnedSemaphorePermit>,
}
pub(crate) struct Attempt {
    pub job_id: String,
    pub provider: DeviceProviderInfo,
    pub owner: Arc<Owner>,
    pub token: CancellationToken,
    pub parent: Option<CancellationToken>,
    pub deadline: tokio::time::Instant,
    pub serial: Arc<AsyncMutex<()>>,
    pub state: Mutex<State>,
    wake: Notify,
}
impl Attempt {
    pub fn new(
        job_id: String,
        provider: DeviceProviderInfo,
        owner: Arc<Owner>,
        parent: Option<CancellationToken>,
        deadline: tokio::time::Instant,
        serial: Arc<AsyncMutex<()>>,
        permit: OwnedSemaphorePermit,
    ) -> Arc<Self> {
        let token = owner.cancel.child_token();
        Arc::new(Self {
            job_id,
            provider,
            owner,
            token,
            parent,
            deadline,
            serial,
            state: Mutex::new(State {
                decision: Decision::Pending,
                started: false,
                finished: false,
                permit: Some(permit),
            }),
            wake: Notify::new(),
        })
    }
    /// 调用方先释放active锁；本函数释放gate后才发出取消信号。
    pub fn reject(&self, reason: Rejection) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(state.decision, Decision::Pending) {
                state.decision = Decision::Cancelled(reason);
            }
        }
        self.token.cancel();
    }
    pub fn check(&self, state: &State) -> Result<()> {
        match &state.decision {
            Decision::Cancelled(reason) => return Err(reason.error()),
            Decision::Accepted(_) => return Err(Error::Conflict("发现已接受".into())),
            Decision::Pending => {}
        }
        if self
            .parent
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(Error::Cancelled);
        }
        if self.owner.cancel.is_cancelled() {
            return Err(Error::Conflict("设备提供者正在卸载".into()));
        }
        if self.token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if tokio::time::Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        Ok(())
    }
    pub fn finish(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(state.decision, Decision::Pending) {
            state.decision = Decision::Cancelled(Rejection::Dependency);
        }
        state.finished = true;
        state.permit.take();
        drop(state);
        self.wake.notify_waiters();
    }
    pub async fn receipt(&self) -> Result<DeviceDirectory> {
        loop {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.finished {
                    return match &state.decision {
                        Decision::Accepted(directory) => Ok((**directory).clone()),
                        Decision::Cancelled(reason) => Err(reason.error()),
                        Decision::Pending => unreachable!("收敛前必须裁定发现"),
                    };
                }
            }
            notified.await;
        }
    }
}
