//! 会话结束后的有界回收续办；只重试清理，不重放设备业务。
use crate::{Application, registry::Owner};
use apk_domain::plugin_recovery::RecoveryInput;
use std::{sync::Arc, time::Duration};

impl Application {
    pub(crate) async fn auto_recover_finished_session(
        self: &Arc<Self>,
        owner: Arc<Owner>,
        input: serde_json::Value,
    ) {
        let until = tokio::time::Instant::now() + Duration::from_secs(100);
        for delay in [0, 250, 1000] {
            if owner.cancel.is_cancelled()
                || self.recovery_cancel.is_cancelled()
                || !owner.info().cleanup_failed
                || owner.executor.recovery_timeout().is_none()
            {
                return;
            }
            tokio::select! {
                _ = owner.cancel.cancelled() => return,
                _ = self.recovery_cancel.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
            }
            // 合并正在回收时到达的旧债务，不能让三次重试全消耗在 busy 响应上。
            while owner.recovering.load(std::sync::atomic::Ordering::Acquire) {
                tokio::select! {
                    _ = owner.cancel.cancelled() => return,
                    _ = self.recovery_cancel.cancelled() => return,
                    _ = tokio::time::sleep_until(until) => return,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                }
            }
            if tokio::time::Instant::now() >= until || !owner.info().cleanup_failed {
                return;
            }
            let info = owner.info();
            if let Err(error) = self
                .recover_plugin(
                    info.id,
                    RecoveryInput {
                        generation: info.generation,
                        input: input.clone(),
                    },
                )
                .await
            {
                tracing::warn!(code = error.code(), "旧会话资源后台回收尚未完成");
            }
        }
    }
}
