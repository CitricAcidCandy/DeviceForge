use apk_application::Application;
use rmcp::{
    ErrorData,
    model::{GetMeta, ServerNotification, ToolListChangedNotification},
    service::SubscriptionContext,
};
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(crate) struct CatalogNotifications {
    slots: Semaphore,
    shutdown: CancellationToken,
}

impl CatalogNotifications {
    pub(crate) fn new(shutdown: CancellationToken) -> Self {
        Self {
            slots: Semaphore::new(32),
            shutdown,
        }
    }

    pub(crate) async fn listen(
        &self,
        app: &Application,
        context: SubscriptionContext,
    ) -> Result<(), ErrorData> {
        let _slot = self
            .slots
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("MCP 工具目录订阅已达到上限", None))?;
        if context.accepted().tools_list_changed != Some(true) {
            tokio::select! {
                _ = context.cancelled() => {},
                _ = self.shutdown.cancelled() => {},
            }
            return Ok(());
        }
        let mut changes = app.subscribe_contributions();
        loop {
            let revision = *changes.borrow_and_update();
            let log = deviceforge_observability::LogContext::current().unwrap_or_default();
            let mut notification =
                ServerNotification::ToolListChangedNotification(ToolListChangedNotification {
                    method: Default::default(),
                    extensions: Default::default(),
                });
            notification
                .get_meta_mut()
                .0
                .insert("deviceforge/log_id".into(), serde_json::json!(log.log_id));
            let sending = context.sink().send(notification);
            let result = tokio::select! {
                biased;
                _ = context.cancelled() => return Ok(()),
                _ = self.shutdown.cancelled() => return Ok(()),
                result = tokio::time::timeout(Duration::from_secs(5), sending) => result,
            };
            match result {
                Ok(Ok(())) => tracing::info!(revision, "MCP 工具目录失效通知已发送"),
                Ok(Err(_)) => {
                    return Err(ErrorData::internal_error("MCP 工具目录通知发送失败", None));
                }
                Err(_) => return Err(ErrorData::internal_error("MCP 工具目录通知发送超时", None)),
            }
            tokio::select! {
                biased;
                _ = context.cancelled() => return Ok(()),
                _ = self.shutdown.cancelled() => return Ok(()),
                changed = changes.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                },
            }
        }
    }
}
