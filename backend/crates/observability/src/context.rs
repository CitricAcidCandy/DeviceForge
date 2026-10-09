use std::future::Future;
use tracing::Instrument;

tokio::task_local! {
    static CONTEXT: LogContext;
}

/// 关联 ID 由宿主生成，不采用请求头或插件提供的身份。
#[derive(Clone, Debug)]
pub struct LogContext {
    pub log_id: String,
}

impl Default for LogContext {
    fn default() -> Self {
        Self {
            log_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}

impl LogContext {
    pub fn current() -> Option<Self> {
        CONTEXT.try_with(Clone::clone).ok()
    }

    pub async fn scope<T>(&self, future: impl Future<Output = T>) -> T {
        CONTEXT.scope(self.clone(), future).await
    }
    pub fn sync_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        CONTEXT.sync_scope(self.clone(), work)
    }

    /// 在创建后台任务时捕获上下文，避免等待调度后读取到别的请求。
    pub fn propagate<T>(future: impl Future<Output = T>) -> impl Future<Output = T> {
        let context = Self::current().unwrap_or_default();
        let span = tracing::Span::current();
        async move { context.scope(future.instrument(span)).await }
    }
}
