//! HTTP、MCP 与 CLI 共用的安装任务；安装状态查询仍使用只读用例。
use crate::plugin_installations::InstallationService;
use apk_domain::{Error, Executor, Operation, OperationExecution, OperationExecutionSource, Result, plugin_installations::*};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationRequest {
    pub source: InstallSource,
    #[serde(default)]
    pub expected_revision: Option<String>,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationUpdate {
    pub id: String,
    pub source: InstallSource,
    pub expected_revision: String,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationChange {
    pub id: String,
    pub expected_revision: String,
    pub enabled: bool,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationDelete {
    pub id: String,
    pub expected_revision: String,
}

#[derive(Default)]
pub struct InstallationOperations(OnceLock<Arc<InstallationService>>);
impl InstallationOperations {
    pub fn bind(&self, service: Arc<InstallationService>) -> Result<()> {
        self.0.set(service).map_err(|_| Error::Conflict("安装服务已绑定".into()))
    }
}
fn schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schemars::SchemaGenerator::default().into_root_schema_for::<T>())
        .expect("公开安装请求模式有效")
}
#[async_trait]
impl Executor for InstallationOperations {
    fn operations(&self) -> Vec<Operation> {
        [
            ("installation.install", "安装完整功能插件", schema::<InstallationRequest>()),
            ("installation.update", "更新完整功能插件", schema::<InstallationUpdate>()),
            ("installation.enabled", "更改完整功能插件启停", schema::<InstallationChange>()),
            ("installation.uninstall", "卸载完整功能插件并保留配置", schema::<InstallationDelete>()),
        ].into_iter().map(|(id,title,input_schema)| Operation { id:id.into(), title:title.into(), input_schema, execution:Some(OperationExecution { api_version:1, total_timeout_ms:3_600_000, source:OperationExecutionSource::Declared }) }).collect()
    }
    async fn execute(&self, operation: &str, input: Value, cancel: CancellationToken) -> Result<Value> {
        if cancel.is_cancelled() { return Err(Error::Cancelled); }
        let service = self.0.get().ok_or_else(|| Error::Dependency("安装服务未绑定".into()))?;
        let decode = |error: serde_json::Error| Error::Invalid(error.to_string());
        let record = match operation {
            "installation.install" => {
                let input: InstallationRequest = serde_json::from_value(input).map_err(decode)?;
                service.install_cancelled(input.source, input.expected_revision, cancel).await?
            },
            "installation.update" => {
                let input: InstallationUpdate = serde_json::from_value(input).map_err(decode)?;
                let old = service.get(&input.id).await?;
                if old.revision != input.expected_revision { return Err(Error::Conflict("安装修订已变化".into())); }
                service.install_cancelled(input.source, Some(input.expected_revision), cancel).await?
            },
            "installation.enabled" => {
                let input: InstallationChange = serde_json::from_value(input).map_err(decode)?;
                service.set_enabled(input.id, input.expected_revision, input.enabled).await?
            },
            "installation.uninstall" => {
                let input: InstallationDelete = serde_json::from_value(input).map_err(decode)?;
                service.delete(input.id, input.expected_revision).await?
            },
            _ => return Err(Error::NotFound(operation.into())),
        };
        serde_json::to_value(record).map_err(|_| Error::Dependency("安装结果编码失败".into()))
    }
}
