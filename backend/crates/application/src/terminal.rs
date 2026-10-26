//! 终态存储编排；先取得工作槽，再取得任务资格，最后执行无全局锁的事务。
use crate::{
    Application,
    completion::{CancellationClaim, Completion, Failure},
    registry::{Owner, Registered},
};
use apk_domain::{Error, Job, JobStatus, JobStore, Result};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) fn cancelled(
    store: &dyn JobStore,
    id: &str,
    completion: Option<&Arc<Completion>>,
    cancel: Option<&CancellationToken>,
) -> Result<Job> {
    rejected(store, id, completion, cancel, None)
}
pub(crate) fn failed(
    store: &dyn JobStore,
    id: &str,
    completion: Option<&Arc<Completion>>,
    cancel: Option<&CancellationToken>,
    failure: Failure,
) -> Result<Job> {
    rejected(store, id, completion, cancel, Some(failure))
}
fn rejected(
    store: &dyn JobStore,
    id: &str,
    completion: Option<&Arc<Completion>>,
    cancel: Option<&CancellationToken>,
    failure: Option<Failure>,
) -> Result<Job> {
    let qualification = completion
        .map(|completion| match &failure {
            Some(failure) => completion.claim_failed(failure.clone()),
            None => completion.claim_cancelled(),
        })
        .transpose()?;
    let (claim, status, error) = match qualification {
        Some(CancellationClaim::Committed(job)) => return Ok(job),
        Some(CancellationClaim::Proceed(claim, status, error)) => (Some(claim), status, error),
        None => (
            None,
            if failure.is_some() {
                JobStatus::Failed
            } else {
                JobStatus::Cancelled
            },
            failure.map(|failure| match failure {
                Failure::CleanupFailed => Error::CleanupFailed.to_string(),
                Failure::Other(message) => message,
            }),
        ),
    };
    if let Some(cancel) = cancel {
        cancel.cancel();
    }
    let job = store.transition(id, status, None, error)?;
    if !job.status.is_terminal() {
        return Err(Error::Storage("拒绝提交未返回任务终态".into()));
    }
    if let Some(claim) = claim {
        claim.committed(job.clone());
    }
    Ok(job)
}

impl Application {
    pub(crate) async fn commit_cancelled(
        self: &Arc<Self>,
        id: String,
        completion: Arc<Completion>,
        cancel: CancellationToken,
        owner: Option<Arc<Owner>>,
    ) -> Result<Job> {
        self.commit_rejected(id, None, completion, cancel, owner)
            .await
    }
    pub(crate) async fn commit_failed(
        self: &Arc<Self>,
        id: String,
        failure: Failure,
        completion: Arc<Completion>,
        cancel: CancellationToken,
        owner: Option<Arc<Owner>>,
    ) -> Result<Job> {
        self.commit_rejected(id, Some(failure), completion, cancel, owner)
            .await
    }
    async fn commit_rejected(
        self: &Arc<Self>,
        id: String,
        failure: Option<Failure>,
        completion: Arc<Completion>,
        cancel: CancellationToken,
        owner: Option<Arc<Owner>>,
    ) -> Result<Job> {
        if let Some(failure) = &failure {
            completion.record_failure(failure)?;
        }
        let store = self.store.clone();
        let application = self.tracker.token();
        let owner = owner.map(|owner| owner.tracker.token());
        self.blocking(move || {
            let _application = application;
            let _owner = owner;
            rejected(
                store.as_ref(),
                &id,
                Some(&completion),
                Some(&cancel),
                failure,
            )
        })
        .await
    }

    pub(crate) async fn commit_success(
        self: &Arc<Self>,
        id: String,
        output: Value,
        target: Arc<Registered>,
        completion: Arc<Completion>,
        cancel: CancellationToken,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<Job> {
        let app = self.clone();
        let application = self.tracker.token();
        let owner = target.owner.as_ref().map(|owner| owner.tracker.token());
        self.blocking(move || {
            let _application = application;
            let _owner = owner;
            let active = app
                .active
                .lock()
                .map_err(|_| Error::Storage("成功提交准入状态异常".into()))?;
            if !active.accepting {
                return Err(Error::Cancelled);
            }
            let claim = app.registry.with_current(&target, || {
                crate::operation_budget::check(deadline, Some(&cancel))?;
                completion.claim(deadline, &cancel)
            })?;
            drop(active);
            let job = app
                .store
                .transition(&id, JobStatus::Succeeded, Some(output), None)?;
            if !job.status.is_terminal() {
                return Err(Error::Storage("成功提交未返回任务终态".into()));
            }
            claim.committed(job.clone());
            Ok(job)
        })
        .await
    }
}
