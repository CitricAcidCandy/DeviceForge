use crate::{ExecutionContext, Result, artifacts::Artifact};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    Apk,
    Aab,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PackageManifest {
    pub artifact_id: String,
    pub format: PackageFormat,
    pub module: Option<String>,
    pub package_name: String,
    pub version_code: Option<String>,
    pub version_name: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
    pub application_label: Option<String>,
    pub debuggable: Option<bool>,
    pub permissions: Vec<String>,
    pub xml: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PackageSigner {
    pub number: u32,
    pub distinguished_name: Option<String>,
    pub certificate_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SignatureScheme {
    pub scheme: String,
    pub verified: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PackageSignature {
    pub artifact_id: String,
    pub verified: bool,
    pub signers: Vec<PackageSigner>,
    pub schemes: Vec<SignatureScheme>,
    pub report: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExtractedApk {
    pub source_artifact_id: String,
    pub entry: String,
    pub artifact: Artifact,
}
#[async_trait]
pub trait PackageAnalyzer: Send + Sync {
    async fn manifest(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<PackageManifest>;
    async fn signature(&self, id: &str, cancel: CancellationToken) -> Result<PackageSignature>;
    async fn extract_apk(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
    ) -> Result<ExtractedApk>;

    /// 兼容旧实现；支持全阶段期限的适配器覆盖此方法并沿用原标准库截止点。
    async fn manifest_with_context(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
        _context: ExecutionContext,
    ) -> Result<PackageManifest> {
        self.manifest(id, module, cancel).await
    }

    /// 默认委托旧签名分析，不在领域端口创建或重置预算。
    async fn signature_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        _context: ExecutionContext,
    ) -> Result<PackageSignature> {
        self.signature(id, cancel).await
    }

    /// 默认委托旧精确条目提取；真实副本与发布期限由覆盖实现负责。
    async fn extract_apk_with_context(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
        _context: ExecutionContext,
    ) -> Result<ExtractedApk> {
        self.extract_apk(id, entry, cancel).await
    }

    /// 没有未确认资源时默认返回 false；有清理观测的适配器须覆盖此方法。
    fn has_unresolved_resources(&self) -> bool {
        false
    }
}
