//! 宿主插件生命周期的公开视图与部署端口，不涉及具体设备平台。
use crate::{Error, Executor, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub fn plugin_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 99
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || id.starts_with("builtin.")
        || !id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
    {
        return Err(Error::Invalid(
            "插件 ID 必须是小写字母、数字及 ._-，以字母或数字开头且最多 99 字节".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginState {
    Loaded,
    Draining,
    Unloaded,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PluginInfo {
    pub id: String,
    pub version: String,
    pub generation: String,
    pub state: PluginState,
    pub operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
    pub protected: bool,
    pub cleanup_failed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginInput {
    pub id: String,
}

pub struct PluginContribution {
    pub id: String,
    pub version: String,
    pub executor: Arc<dyn Executor>,
}

#[async_trait]
pub trait PluginCatalog: Send + Sync {
    /// 只按 ID 读取部署者已发布的插件，不能由请求选择入口或任意路径。
    async fn load(&self, id: &str) -> Result<PluginContribution>;
}
