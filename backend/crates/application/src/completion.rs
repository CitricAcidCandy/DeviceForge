//! 每任务终态提交资格的短时门禁；不持有门禁锁执行存储事务。
use apk_domain::{Error, Job, Result};
use std::sync::{Arc, Condvar, Mutex};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
mod tests;

enum State {
    Pending,
    Rejected(Rejection),
    Committing,
    Committed(Job),
}
#[derive(Clone, Copy)]
enum Rejection {
    Cancelled,
    Timeout,
    CleanupFailed,
}

/// 清理失败保留类型；普通失败的可读诊断在边界映射，不按字符串猜测风险。
#[derive(Clone)]
pub(crate) enum Failure {
    CleanupFailed,
    Other(String),
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        match error {
            Error::CleanupFailed => Self::CleanupFailed,
            other => Self::Other(other.to_string()),
        }
    }
}

pub(crate) struct Completion {
    state: Mutex<State>,
    finished: Condvar,
    deadline: Option<tokio::time::Instant>,
}

impl Completion {
    #[cfg(test)]
    pub fn new() -> Arc<Self> {
        Self::with_deadline(None)
    }
    pub fn with_deadline(deadline: Option<tokio::time::Instant>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::Pending),
            finished: Condvar::new(),
            deadline,
        })
    }

    /// false 表示终态资格已先取得；调用者不得再抢写取消终态。
    pub fn request_cancel(&self) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("任务提交资格异常".into()))?;
        match &*state {
            State::Pending | State::Rejected(_) => {
                let rejection = if matches!(*state, State::Rejected(Rejection::CleanupFailed)) {
                    Rejection::CleanupFailed
                } else if self.expired() || matches!(*state, State::Rejected(Rejection::Timeout)) {
                    Rejection::Timeout
                } else {
                    Rejection::Cancelled
                };
                *state = State::Rejected(rejection);
                Ok(true)
            }
            State::Committing | State::Committed(_) => Ok(false),
        }
    }

    /// 仅在阻塞工作池或同步兼容边界调用，异步调度线程不得等待条件变量。
    #[cfg(test)]
    pub fn cancel_after_commit(&self) -> Result<Option<Job>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("任务提交资格异常".into()))?;
        loop {
            match &*state {
                State::Committing => {
                    state = self
                        .finished
                        .wait(state)
                        .map_err(|_| Error::Storage("任务提交排空异常".into()))?;
                }
                State::Committed(job) => return Ok(Some(job.clone())),
                State::Pending | State::Rejected(_) => {
                    let rejection = if matches!(*state, State::Rejected(Rejection::CleanupFailed)) {
                        Rejection::CleanupFailed
                    } else if self.expired()
                        || matches!(*state, State::Rejected(Rejection::Timeout))
                    {
                        Rejection::Timeout
                    } else {
                        Rejection::Cancelled
                    };
                    *state = State::Rejected(rejection);
                    return Ok(None);
                }
            }
        }
    }
    /// 取消终态也有一次资格；资格前到期保持超时，资格后的事务独立收敛。
    pub fn claim_cancelled(self: &Arc<Self>) -> Result<CancellationClaim> {
        self.claim_rejected(None)
    }
    pub fn claim_failed(self: &Arc<Self>, failure: Failure) -> Result<CancellationClaim> {
        self.claim_rejected(Some(failure))
    }
    /// 清理风险已观测时立即拒绝成功；等待存储槽不能延迟这一短时裁定。
    pub fn record_failure(&self, failure: &Failure) -> Result<()> {
        if matches!(failure, Failure::CleanupFailed) {
            let mut state = self
                .state
                .lock()
                .map_err(|_| Error::Storage("清理风险裁定异常".into()))?;
            if matches!(*state, State::Pending | State::Rejected(_)) {
                *state = State::Rejected(Rejection::CleanupFailed);
            }
        }
        Ok(())
    }
    fn claim_rejected(self: &Arc<Self>, failure: Option<Failure>) -> Result<CancellationClaim> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("任务取消资格异常".into()))?;
        loop {
            match &*state {
                State::Committing => {
                    state = self
                        .finished
                        .wait(state)
                        .map_err(|_| Error::Storage("任务终态提交排空异常".into()))?;
                }
                State::Committed(job) => return Ok(CancellationClaim::Committed(job.clone())),
                State::Pending | State::Rejected(_) => {
                    let cleanup_failed = matches!(failure, Some(Failure::CleanupFailed))
                        || matches!(*state, State::Rejected(Rejection::CleanupFailed));
                    let timeout =
                        self.expired() || matches!(*state, State::Rejected(Rejection::Timeout));
                    let cancelled = matches!(*state, State::Rejected(Rejection::Cancelled));
                    let (status, error) = if cleanup_failed {
                        (
                            apk_domain::JobStatus::Failed,
                            Some(Error::CleanupFailed.to_string()),
                        )
                    } else if timeout {
                        (
                            apk_domain::JobStatus::Failed,
                            Some(Error::Timeout.to_string()),
                        )
                    } else if cancelled || failure.is_none() {
                        (apk_domain::JobStatus::Cancelled, None)
                    } else {
                        let Some(Failure::Other(message)) = failure else {
                            unreachable!("清理失败已先裁定")
                        };
                        (apk_domain::JobStatus::Failed, Some(message))
                    };
                    let rejection = if cleanup_failed {
                        Some(Rejection::CleanupFailed)
                    } else if timeout {
                        Some(Rejection::Timeout)
                    } else if cancelled || error.is_none() {
                        Some(Rejection::Cancelled)
                    } else {
                        None
                    };
                    *state = State::Committing;
                    return Ok(CancellationClaim::Proceed(
                        Claim {
                            completion: self.clone(),
                            committed: false,
                            rejection,
                        },
                        status,
                        error,
                    ));
                }
            }
        }
    }

    pub fn claim(
        self: &Arc<Self>,
        deadline: Option<tokio::time::Instant>,
        cancel: &CancellationToken,
    ) -> Result<Claim> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("任务提交资格异常".into()))?;
        crate::operation_budget::check(deadline, Some(cancel))?;
        match &*state {
            State::Pending => {
                *state = State::Committing;
                Ok(Claim {
                    completion: self.clone(),
                    committed: false,
                    rejection: None,
                })
            }
            State::Rejected(Rejection::Cancelled) => Err(Error::Cancelled),
            State::Rejected(Rejection::Timeout) => Err(Error::Timeout),
            State::Rejected(Rejection::CleanupFailed) => Err(Error::CleanupFailed),
            State::Committing | State::Committed(_) => {
                Err(Error::Conflict("成功提交资格不能重复取得".into()))
            }
        }
    }
    fn expired(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
    }
    #[cfg(test)]
    pub fn cancellation_error(&self) -> Result<Error> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("任务取消裁定异常".into()))?;
        Ok(
            if matches!(*state, State::Rejected(Rejection::CleanupFailed)) {
                Error::CleanupFailed
            } else if matches!(*state, State::Rejected(Rejection::Timeout)) {
                Error::Timeout
            } else {
                Error::Cancelled
            },
        )
    }
}

pub(crate) enum CancellationClaim {
    Committed(Job),
    Proceed(Claim, apk_domain::JobStatus, Option<String>),
}

pub(crate) struct Claim {
    completion: Arc<Completion>,
    committed: bool,
    rejection: Option<Rejection>,
}
impl Claim {
    pub fn committed(mut self, job: Job) {
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *state = State::Committed(job);
        self.committed = true;
        self.completion.finished.notify_all();
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        if !self.committed {
            let mut state = self
                .completion
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(*state, State::Committing) {
                *state = self.rejection.map_or(State::Pending, State::Rejected);
            }
            self.completion.finished.notify_all();
        }
    }
}
