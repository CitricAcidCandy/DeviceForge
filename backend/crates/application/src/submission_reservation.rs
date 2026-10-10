//! 创建中预留只持有有界准入和排空凭据；存储操作始终在准入锁外。
use crate::{
    Active, Application,
    devices::attempt::{Attempt, Rejection},
    registry::Owner,
};
use apk_domain::Error;
use std::sync::Arc;
use tokio_util::{sync::CancellationToken, task::task_tracker::TaskTrackerToken};

pub(crate) struct Creating {
    app: Arc<Application>,
    id: String,
    attempt: Option<Arc<Attempt>>,
    completion: Arc<crate::completion::Completion>,
    handed_off: bool,
    _application: TaskTrackerToken,
    _owner: Option<TaskTrackerToken>,
}
impl Creating {
    pub fn reserve(
        app: &Arc<Application>,
        active: &mut Active,
        id: String,
        token: CancellationToken,
        attempt: Option<Arc<Attempt>>,
        owner: Option<&Arc<Owner>>,
        deadline: Option<tokio::time::Instant>,
    ) -> Self {
        active.tokens.insert(id.clone(), token);
        let completion = crate::completion::Completion::with_deadline(deadline);
        active.completions.insert(id.clone(), completion.clone());
        active.creating.insert(id.clone());
        if let Some(attempt) = &attempt {
            active.discoveries.insert(id.clone(), attempt.clone());
        }
        Self {
            app: app.clone(),
            id,
            attempt,
            completion,
            handed_off: false,
            _application: app.tracker.token(),
            _owner: owner.map(|owner| owner.tracker.token()),
        }
    }
    /// 新运行任务已经被两个tracker登记后，才能释放创建中计数。
    pub fn hand_off(&mut self, active: &mut Active) {
        active.creating.remove(&self.id);
        self.handed_off = true;
    }
    pub fn reject(&self, error: &Error) {
        if let Some(attempt) = &self.attempt {
            attempt.reject(Rejection::from_error(error));
        }
    }
    /// 仅在create成功后调用；失败历史保持可追溯，不吞掉补偿失败。
    pub fn compensate(&self, error: Error) -> Error {
        self.reject(&error);
        let cancelled = matches!(error, Error::Cancelled);
        let compensated = if cancelled {
            crate::terminal::cancelled(
                self.app.store.as_ref(),
                &self.id,
                Some(&self.completion),
                None,
            )
        } else {
            crate::terminal::failed(
                self.app.store.as_ref(),
                &self.id,
                Some(&self.completion),
                None,
                if matches!(error, Error::CleanupFailed) {
                    crate::completion::Failure::CleanupFailed
                } else {
                    crate::completion::Failure::Other(format!(
                        "任务创建后准入失败：{}",
                        error.code()
                    ))
                },
            )
        };
        if let Err(compensation) = compensated {
            tracing::error!(job_id = %self.id, code = error.code(), compensation_code = compensation.code(), "任务创建后拒绝与终态补偿均失败，历史待恢复");
            return Error::Storage(format!("任务准入及终态补偿失败，任务需恢复：{}", self.id));
        }
        error
    }
}
impl Drop for Creating {
    fn drop(&mut self) {
        if self.handed_off {
            return;
        }
        {
            let mut active = self
                .app
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            active.creating.remove(&self.id);
            active.tokens.remove(&self.id);
            active.completions.remove(&self.id);
            active.discoveries.remove(&self.id);
        }
        if let Some(attempt) = &self.attempt {
            attempt.reject(Rejection::Dependency);
            self.app.registry.forget_discovery(attempt);
            attempt.finish();
        }
    }
}
