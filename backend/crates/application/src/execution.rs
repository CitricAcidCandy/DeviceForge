//! 执行器首次轮询准入；取消清理等待不得启动尚未执行的任务。
use crate::registry::Owner;
use apk_domain::{Error, Executor, Result};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

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
    executor
        .execute_with_context(
            operation,
            input,
            cancel,
            apk_domain::ExecutionContext {
                deadline: deadline.map(tokio::time::Instant::into_std),
            },
        )
        .await
}
