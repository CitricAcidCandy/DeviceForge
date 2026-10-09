use crate::{Error, Result, artifacts::Artifact, identifier};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(schemars::JsonSchema)]
#[schemars(transparent)]
#[allow(dead_code)]
struct SpecToken(
    #[schemars(length(min = 1, max = 80), regex(pattern = "^[A-Za-z0-9_-]+$"))] String,
);

/// 常见设备匹配维度；不接收 bundletool 任意 JSON 或服务器文件路径。
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceSpec {
    #[schemars(with = "Vec<SpecToken>", length(min = 1, max = 16))]
    pub supported_abis: Vec<String>,
    #[schemars(with = "Vec<SpecToken>", length(min = 1, max = 100))]
    pub supported_locales: Vec<String>,
    #[schemars(range(min = 1, max = 10000))]
    pub screen_density: u32,
    #[schemars(range(min = 1, max = 10000))]
    pub sdk_version: u32,
}
impl DeviceSpec {
    pub fn validate(&self) -> Result<()> {
        fn tokens(values: &[String], max: usize) -> bool {
            let mut unique = std::collections::HashSet::new();
            !values.is_empty()
                && values.len() <= max
                && values.iter().all(|value| {
                    !value.is_empty()
                        && value.len() <= 80
                        && value
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                        && unique.insert(value)
                })
        }
        if !tokens(&self.supported_abis, 16)
            || !tokens(&self.supported_locales, 100)
            || !(1..=10000).contains(&self.screen_density)
            || !(1..=10000).contains(&self.sdk_version)
        {
            return Err(Error::Invalid(
                "设备规格列表或数值无效，列表元素必须唯一且为受限标识".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExtractSplitsRequest {
    #[schemars(regex(
        pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ))]
    pub artifact_id: String,
    pub device_spec: DeviceSpec,
}
fn artifact_id(id: &str) -> Result<()> {
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err(Error::Invalid("产物 ID 必须为规范 UUID".into()));
    }
    Ok(())
}
impl ExtractSplitsRequest {
    pub fn validate(&self) -> Result<()> {
        artifact_id(&self.artifact_id)?;
        self.device_spec.validate()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallApksRequest {
    #[schemars(regex(
        pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ))]
    pub artifact_id: String,
    #[schemars(
        length(min = 1, max = 200),
        regex(pattern = r"^[A-Za-z0-9._:\[\]][A-Za-z0-9._:\[\]-]*$")
    )]
    pub device_id: String,
}
impl InstallApksRequest {
    pub fn validate(&self) -> Result<()> {
        artifact_id(&self.artifact_id)?;
        identifier(&self.device_id)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExtractedSplits {
    pub source_artifact_id: String,
    pub device_spec: DeviceSpec,
    pub artifact: Artifact,
    pub apk_entries: Vec<String>,
}
/// 表示工具完成安装调用；不证明应用已启动或业务可用。
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ApksInstalled {
    pub artifact_id: String,
    pub device_id: String,
    pub installed: bool,
}
#[async_trait]
pub trait SplitPackages: Send + Sync {
    async fn extract(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
    ) -> Result<ExtractedSplits>;
    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled>;
}
