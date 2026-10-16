//! 便携插件包部署端口，不依赖归档、HTTP 或程序进程。
use crate::{Operation, Result, artifacts::ArtifactStream};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PackageKind {
    Server,
    Browser,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    Zip,
    Tgz,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PackageInfo {
    pub kind: PackageKind,
    pub id: String,
    pub version: String,
    pub runtime: String,
    pub entry_path: String,
    pub entry_url: Option<String>,
    pub api_version: Option<u32>,
    pub installed_at: u64,
}

pub struct PackageAsset {
    pub content_type: String,
    pub size: u64,
    pub stream: ArtifactStream,
}

#[async_trait]
pub trait PreparedPackage: Send {
    fn info(&self) -> &PackageInfo;
    fn operations(&self) -> &[Operation];
    /// 消费暂存所有权，验证结束后才原子发布。
    async fn commit(self: Box<Self>) -> Result<PackageInfo>;
    /// 新包已完成验证后替换旧部署；失败须保留可用的旧部署。
    async fn replace(self: Box<Self>) -> Result<PackageInfo> {
        Err(crate::Error::Conflict("包存储不支持安全更新".into()))
    }
}

#[async_trait]
pub trait PackageStore: Send + Sync {
    async fn prepare(
        &self,
        kind: PackageKind,
        format: PackageFormat,
        stream: ArtifactStream,
    ) -> Result<Box<dyn PreparedPackage>>;
    async fn list(&self, kind: PackageKind) -> Result<Vec<PackageInfo>>;
    async fn delete(&self, kind: PackageKind, id: &str) -> Result<PackageInfo>;
    async fn asset(&self, id: &str, path: &str) -> Result<PackageAsset>;
}
