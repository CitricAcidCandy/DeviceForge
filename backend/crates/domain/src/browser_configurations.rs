//! 浏览器插件原值配置的完整记录与 CAS 端口，不依赖插件安装状态。
use crate::{Error, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BROWSER_CONFIGURATION_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserConfigurationRecord {
    pub version: u32,
    pub values: Value,
    pub revision: String,
    pub applied: String,
    pub sensitive_paths: Vec<String>,
}

/// `defaults` 兼容尚未产生修订的历史浏览器记录；其他修订使用 UUID。
pub fn validate_browser_revision(revision: &str) -> Result<()> {
    if revision == "defaults" || uuid::Uuid::parse_str(revision).is_ok() {
        return Ok(());
    }
    Err(Error::Invalid(
        "浏览器配置修订必须为 defaults 或 UUID".into(),
    ))
}

impl BrowserConfigurationRecord {
    pub fn validate(&self) -> Result<()> {
        if self.version == 0 {
            return Err(Error::Invalid("浏览器配置版本必须为正整数".into()));
        }
        if !self.values.is_object() {
            return Err(Error::Invalid("浏览器配置 values 必须为 JSON 对象".into()));
        }
        validate_browser_revision(&self.revision)?;
        validate_browser_revision(&self.applied)?;
        if self.sensitive_paths.iter().any(|path| {
            (!path.is_empty() && !path.starts_with('/')) || path.chars().any(char::is_control)
        }) {
            return Err(Error::Invalid("浏览器配置敏感字段路径无效".into()));
        }
        let bytes =
            serde_json::to_vec(self).map_err(|_| Error::Invalid("浏览器配置不能序列化".into()))?;
        if bytes.len() > BROWSER_CONFIGURATION_LIMIT {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserConfigurationView {
    pub record: Option<BrowserConfigurationRecord>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserConfigurationPatch {
    /// null 仅允许创建尚不存在的记录；已有记录必须与当前 revision 完全相等。
    #[serde(deserialize_with = "required_revision")]
    pub expected_revision: Option<String>,
    pub record: BrowserConfigurationRecord,
}

fn required_revision<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[async_trait]
pub trait BrowserConfigurationStore: Send + Sync {
    async fn get(&self, id: &str) -> Result<Option<BrowserConfigurationRecord>>;
    async fn patch(
        &self,
        id: &str,
        expected: Option<String>,
        record: BrowserConfigurationRecord,
    ) -> Result<BrowserConfigurationRecord>;
}
