//! 宿主保留的 APKS 安装侧车；离线提取由独立包插件承担。
use super::operation;
use apk_domain::{
    Error, ExecutionContext, Executor, Operation, Result,
    splits::{InstallApksRequest, SplitPackages},
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct InstallApksOperations(pub Arc<dyn SplitPackages>);

#[async_trait]
impl Executor for InstallApksOperations {
    fn operations(&self) -> Vec<Operation> {
        vec![operation::<InstallApksRequest>(
            "android.app.install_apks",
            "匹配指定设备并安装 APKS",
        )]
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, ExecutionContext::default())
            .await
    }

    fn has_unresolved_resources(&self) -> bool {
        self.0.has_unresolved_resources()
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        crate::operation_budget::check(
            context.deadline.map(tokio::time::Instant::from_std),
            Some(&cancel),
        )?;
        if operation != "android.app.install_apks" {
            return Err(Error::NotFound(operation.into()));
        }
        let request: InstallApksRequest =
            serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
        request.validate()?;
        // 安装仍使用既有领域端口；此侧车只做入口预检，不宣称新增全阶段期限传播。
        let installed = self.0.install(request, cancel).await?;
        serde_json::to_value(installed).map_err(|error| Error::Dependency(error.to_string()))
    }
}
