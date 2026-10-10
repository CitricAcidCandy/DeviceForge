//! 固定四流的残余侧车；不复制底层业务，也不增强底层清理或期限资格。
use super::DeviceArtifactActions;
use apk_domain::artifacts::ArtifactStore;
use apk_domain::{Error, ExecutionContext, Executor, ExecutorResultFormat, Operation, Result};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct RemainingDeviceArtifactActions {
    inner: DeviceArtifactActions,
}

fn allowed(operation: &str) -> bool {
    matches!(
        operation,
        "android.app.install"
            | "android.screenshot"
            | "harmony.app.install"
            | "harmony.app.uninstall"
    )
}

impl RemainingDeviceArtifactActions {
    pub fn new(adb: String, hdc: String, artifacts: Arc<dyn ArtifactStore>) -> Self {
        Self {
            inner: DeviceArtifactActions {
                adb,
                hdc,
                artifacts,
            },
        }
    }

    fn check_operation(operation: &str) -> Result<()> {
        if !allowed(operation) {
            return Err(Error::NotFound(operation.into()));
        }
        Ok(())
    }
}

#[async_trait]
impl Executor for RemainingDeviceArtifactActions {
    fn operations(&self) -> Vec<Operation> {
        self.inner
            .operations()
            .into_iter()
            .filter(|operation| allowed(&operation.id))
            .collect()
    }

    fn result_format(&self) -> ExecutorResultFormat {
        self.inner.result_format()
    }

    fn has_unresolved_resources(&self) -> bool {
        self.inner.has_unresolved_resources()
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        Self::check_operation(operation)?;
        self.inner.execute(operation, input, cancel).await
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        Self::check_operation(operation)?;
        self.inner
            .execute_with_context(operation, input, cancel, context)
            .await
    }
}

#[cfg(test)]
mod tests;
