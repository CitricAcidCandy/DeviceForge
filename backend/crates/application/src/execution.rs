//! 执行器首次轮询准入；取消清理等待不得启动尚未执行的任务。
use crate::registry::Owner;
use apk_domain::{Error, Executor, Result};
use futures_util::FutureExt;
use serde_json::Value;
use std::{future::Future, panic::AssertUnwindSafe, time::Duration};
use tokio_util::sync::CancellationToken;

type Caught<T> = std::result::Result<Result<T>, Box<dyn std::any::Any + Send>>;
type Cleanup<T> = std::result::Result<Caught<T>, tokio::time::error::Elapsed>;

struct RiskGuard<'a> {
    owner: Option<&'a Owner>,
    confirmed: bool,
}
impl Drop for RiskGuard<'_> {
    fn drop(&mut self) {
        if !self.confirmed
            && let Some(owner) = self.owner
        {
            owner.mark_unresolved();
        }
    }
}

/// 普通任务和内部采样共享首轮询、唯一期限与两秒清理窗口。
pub(crate) async fn settle<F, T>(
    future: F,
    cancel: &CancellationToken,
    owner: Option<&Owner>,
    deadline: Option<tokio::time::Instant>,
) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    crate::operation_budget::check(deadline, Some(cancel))?;
    if owner.is_some_and(|owner| owner.info().cleanup_failed) {
        return Err(Error::CleanupFailed);
    }
    let execution = AssertUnwindSafe(async {
        // 准入后其他线程仍可能取消；清理轮询不能因此首次启动业务Future。
        crate::operation_budget::check(deadline, Some(cancel))?;
        future.await
    })
    .catch_unwind();
    tokio::pin!(execution);
    // 逆声明序析构：外层等待被丢弃时先标记owner，再释放业务Future持有的守卫。
    let mut risk = RiskGuard {
        owner,
        confirmed: false,
    };
    let result = tokio::select! {
        biased;
        _ = crate::devices::locks::deadline(deadline) => {
            cancel.cancel();
            let cleanup = tokio::time::timeout(Duration::from_secs(2), &mut execution).await;
            cleanup_result(cleanup, &mut risk, Error::Timeout)
        },
        _ = cancel.cancelled() => {
            // 首次观察时固定原因；清理跨过业务截止点不能改写先到的取消。
            let reason = if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                Error::Timeout
            } else {
                Error::Cancelled
            };
            let cleanup = tokio::time::timeout(Duration::from_secs(2), &mut execution).await;
            cleanup_result(cleanup, &mut risk, reason)
        },
        result = &mut execution => match result {
            Ok(result) => { risk.confirmed = true; result },
            Err(_) => Err(Error::Dependency("执行器发生内部异常".into())),
        },
    };
    if (!risk.confirmed || matches!(result, Err(Error::CleanupFailed)))
        && let Some(owner) = owner
    {
        owner.mark_unresolved();
    }
    if owner.is_some_and(|owner| owner.info().cleanup_failed) {
        Err(Error::CleanupFailed)
    } else {
        result
    }
}

fn cleanup_result<T>(outcome: Cleanup<T>, risk: &mut RiskGuard<'_>, reason: Error) -> Result<T> {
    match outcome {
        Ok(Ok(Err(Error::CleanupFailed))) => {
            risk.confirmed = true;
            Err(Error::CleanupFailed)
        }
        Ok(Ok(_)) => {
            risk.confirmed = true;
            Err(reason)
        }
        _ => Err(reason),
    }
}

pub(crate) async fn execute(
    executor: &dyn Executor,
    operation: &str,
    input: Value,
    cancel: CancellationToken,
    owner: Option<&Owner>,
    deadline: Option<tokio::time::Instant>,
) -> Result<Value> {
    // 到调用执行器之间没有 await，避免异步状态更新后使用旧准入结论。
    crate::operation_budget::check(deadline, Some(&cancel))?;
    if owner.is_some_and(|owner| owner.info().cleanup_failed) {
        return Err(Error::Conflict("插件资源清理未确认，拒绝启动执行器".into()));
    }
    let result = executor
        .execute_with_context(
            operation,
            input,
            cancel,
            apk_domain::ExecutionContext {
                deadline: deadline.map(tokio::time::Instant::into_std),
            },
        )
        .await;
    if matches!(result, Err(Error::CleanupFailed))
        && let Some(owner) = owner
    {
        owner.mark_unresolved();
    }
    result
}

#[cfg(test)]
mod tests;
