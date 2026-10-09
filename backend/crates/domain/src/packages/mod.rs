use crate::{Result, artifacts::Artifact};
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
}
