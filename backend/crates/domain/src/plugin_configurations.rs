//! 统一插件配置的公开视图与存储端口，不读取文件或启动插件。
use crate::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationApplyPolicy {
    NextInvocation,
    PluginReload,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationDefinition {
    pub version: u32,
    pub schema: Value,
    pub defaults: Value,
    pub apply_policy: ConfigurationApplyPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_filename: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ConfigurationFieldError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationSource {
    Legacy,
    Managed,
    Defaults,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PluginConfiguration {
    pub kind: String,
    pub id: String,
    pub definition: Option<ConfigurationDefinition>,
    pub values: Value,
    pub revision: u64,
    pub applied_revision: u64,
    pub pending_reload: bool,
    pub compatible: bool,
    pub field_errors: Vec<ConfigurationFieldError>,
    pub source: ConfigurationSource,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationPatch {
    pub expected_revision: u64,
    pub patch: Value,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationRevision {
    pub expected_revision: u64,
}

#[async_trait]
pub trait PluginConfigurationStore: Send + Sync {
    async fn list(&self) -> Result<Vec<PluginConfiguration>>;
    async fn get(&self, id: &str) -> Result<PluginConfiguration>;
    async fn patch(&self, id: &str, expected: u64, patch: Value) -> Result<PluginConfiguration>;
    async fn reset(&self, id: &str, expected: u64) -> Result<PluginConfiguration>;
    async fn mark_applied(&self, id: &str, expected: u64) -> Result<PluginConfiguration>;
    /// 路径指向不可变的原值修订，仅传给插件进程，不进入公开响应。
    async fn invocation_path(&self, id: &str) -> Result<Option<PathBuf>>;
    /// 资源路径独立于协议和配置修订；旧部署没有托管资源时保持 None。
    async fn resources_path(&self, _id: &str) -> Result<Option<PathBuf>> {
        Ok(None)
    }
    /// 安装启用门禁只返回原值是否已填写，不向调用方暴露敏感字段。
    async fn requirements_configured(&self, id: &str, pointers: &[String]) -> Result<bool> {
        let configuration = self.get(id).await?;
        Ok(configuration.compatible
            && pointers.iter().all(|pointer| {
                configuration
                    .values
                    .pointer(pointer)
                    .is_some_and(|value| match value {
                        Value::Null => false,
                        Value::String(value) => !value.trim().is_empty(),
                        Value::Array(value) => !value.is_empty(),
                        Value::Object(value) => !value.is_empty(),
                        _ => true,
                    })
            }))
    }
}
