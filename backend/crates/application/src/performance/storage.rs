//! 性能存储的期限等待与阻塞执行边界；跟踪令牌覆盖真实数据库工作。
use super::PerformanceService;
use crate::registry::Owner;
use apk_domain::{
    Error, Result,
    performance::{
        PerformanceList, PerformancePage, PerformanceSamples, PerformanceSession,
        PerformanceSessions, PerformanceStore,
    },
};
use deviceforge_observability::LogContext;
use std::{
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct CallContext {
    pub cancel: CancellationToken,
    pub deadline: Option<Instant>,
}

impl CallContext {
    pub(super) fn new(cancel: CancellationToken, deadline: Option<Instant>) -> Self {
        Self { cancel, deadline }
    }

    pub(super) fn unbounded() -> Self {
        Self::new(CancellationToken::new(), None)
    }

    pub(super) fn check(&self) -> Result<()> {
        crate::operation_budget::check(self.deadline, Some(&self.cancel))
    }

    pub(super) async fn wait<F: Future>(&self, future: F) -> Result<F::Output> {
        self.check()?;
        let result = tokio::select! {
            biased;
            _ = crate::devices::locks::deadline(self.deadline) => Err(Error::Timeout),
            _ = self.cancel.cancelled() => Err(Error::Cancelled),
            output = future => Ok(output),
        };
        // 同轮完成、取消和过期同时发生时，原截止点仍优先。
        self.check()?;
        result
    }
}

impl PerformanceService {
    pub async fn get(&self, id: String) -> Result<PerformanceSession> {
        let context = CallContext::unbounded();
        self.get_with_context(id, &context).await
    }

    pub(super) async fn get_with_context(
        &self,
        id: String,
        context: &CallContext,
    ) -> Result<PerformanceSession> {
        super::valid_id(&id)?;
        let (owner, _active_token) = self.tracked_owner(&id, context).await?;
        self.database(owner, context, move |store| store.get(&id))
            .await
    }

    pub async fn samples(&self, request: PerformanceSamples) -> Result<PerformancePage> {
        let context = CallContext::unbounded();
        self.samples_with_context(request, &context).await
    }

    pub(super) async fn samples_with_context(
        &self,
        request: PerformanceSamples,
        context: &CallContext,
    ) -> Result<PerformancePage> {
        super::valid_id(&request.session_id)?;
        let (owner, _active_token) = self.tracked_owner(&request.session_id, context).await?;
        self.database(owner, context, move |store| {
            store.samples(&request.session_id, request.after, request.limit)
        })
        .await
    }

    pub async fn list(&self, request: PerformanceList) -> Result<PerformanceSessions> {
        let context = CallContext::unbounded();
        self.list_with_context(request, &context).await
    }

    pub(super) async fn list_with_context(
        &self,
        request: PerformanceList,
        context: &CallContext,
    ) -> Result<PerformanceSessions> {
        if let Some(id) = &request.after_id {
            super::valid_id(id)?;
        }
        // 全局历史查询无需当前来源，也不依赖活动采样器。
        self.database(None, context, move |store| {
            store.list(request.after_id.as_deref(), request.limit)
        })
        .await
    }

    async fn tracked_owner(
        &self,
        id: &str,
        context: &CallContext,
    ) -> Result<(
        Option<Arc<Owner>>,
        Option<tokio_util::task::task_tracker::TaskTrackerToken>,
    )> {
        let controls = context.wait(self.0.controls.lock()).await?;
        let owner = controls
            .active
            .get(id)
            .filter(|active| active.pending_terminal.is_none())
            .and_then(|active| active.runtime.owner());
        // 待重试终态只有历史归属，不向已排空的旧 owner 添加读闭包。
        let token = owner.as_ref().map(|owner| owner.claim()).transpose()?;
        Ok((owner, token))
    }

    pub(super) async fn database<T: Send + 'static>(
        &self,
        owner: Option<Arc<Owner>>,
        context: &CallContext,
        work: impl FnOnce(&dyn PerformanceStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        // 排队也登记排空凭据；取得许可后将凭据整体转交真实工作闭包。
        let service_token = self.0.tracker.token();
        let owner_token = owner.as_ref().map(|owner| owner.claim()).transpose()?;
        let permit = context
            .wait(self.0.storage_workers.clone().acquire_owned())
            .await?
            .map_err(|_| Error::Storage("性能存储工作池已关闭".into()))?;
        let store = self.0.store.clone();
        let work_context = context.clone();
        let worker_owner = owner.clone();
        let log_context = LogContext::current().unwrap_or_default();
        let span = tracing::Span::current();
        let handle = tokio::task::spawn_blocking(move || {
            // 外层等待被丢弃或超时，仍由阻塞闭包持有容量、令牌和工作捕获的锁。
            let _permit = permit;
            let _service_token = service_token;
            let _owner_token = owner_token;
            let result = catch_unwind(AssertUnwindSafe(|| {
                // 阻塞线程可能延后调度，首次 I/O 之前必须再次检查原期限。
                work_context.check()?;
                log_context.sync_scope(|| span.in_scope(|| work(store.as_ref())))
            }));
            match result {
                Ok(result) => result,
                Err(_) => {
                    if let Some(owner) = &worker_owner {
                        owner.mark_unresolved();
                    }
                    Err(Error::Storage("性能数据库执行异常".into()))
                }
            }
        });
        context.wait(handle).await?.map_err(|_| {
            if let Some(owner) = &owner {
                owner.mark_unresolved();
            }
            Error::Storage("性能数据库执行异常".into())
        })?
    }
}
