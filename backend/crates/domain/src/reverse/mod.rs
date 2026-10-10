use crate::{ExecutionContext, Result, artifacts::Artifact};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DecodedPackage {
    pub source_artifact_id: String,
    pub artifact: Artifact,
    pub files: usize,
    pub unpacked_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SdkRule {
    pub name: String,
    pub package_path: String,
    pub class_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SdkFinding {
    pub rule: SdkRule,
    pub package_found: bool,
    pub class_found: Option<bool>,
    pub evidence: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SdkScan {
    pub artifact_id: String,
    pub findings: Vec<SdkFinding>,
}
#[async_trait]
pub trait PackageReverse: Send + Sync {
    async fn decode(&self, id: &str, cancel: CancellationToken) -> Result<DecodedPackage>;
    async fn scan_sdks(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
    ) -> Result<SdkScan>;

    /// 默认兼容旧反编译端口，不自行补充或刷新预算。
    async fn decode_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        _: ExecutionContext,
    ) -> Result<DecodedPackage> {
        self.decode(id, cancel).await
    }

    /// 默认兼容旧检测端口；实际支持期限的适配器应覆盖本入口。
    async fn scan_sdks_with_context(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
        _: ExecutionContext,
    ) -> Result<SdkScan> {
        self.scan_sdks(id, rules, cancel).await
    }

    fn has_unresolved_resources(&self) -> bool {
        false
    }
}
