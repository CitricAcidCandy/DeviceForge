//! 显式刷新只提交一份统一发现并消费本attempt回执，不猜GET最新目录。
use super::DeviceService;
use apk_domain::{Error, Result, devices::*};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl DeviceService {
    pub async fn refresh(self: &Arc<Self>, request: ProviderInput) -> Result<DeviceDirectory> {
        apk_domain::plugins::plugin_id(&request.id)?;
        if request.generation.is_empty() || request.generation.len() > 100 {
            return Err(Error::Invalid("提供者generation无效".into()));
        }
        let (_, registered) =
            self.app
                .registry
                .provider_operation(&request.id, &request.generation, None)?;
        let operation = registered.operation.id.clone();
        let input = serde_json::json!({});
        let submission = self
            .app
            .prepare_submission(input.clone(), registered, None)?;
        let cancel = CancellationToken::new();
        let _guard = CancelOnDrop(cancel.clone());
        let (_, attempt) = self
            .app
            .dispatch_submission(operation, input, submission, Some(cancel.clone()))
            .await?;
        let attempt = attempt.ok_or_else(|| Error::Dependency("发现提交缺少同次回执".into()))?;
        // 请求丢弃时仍由tracked原任务负责取消、存储和清理；等待不拥有许可。
        attempt.receipt().await
    }
}
