use crate::Result;
use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

pub type ArtifactStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;

pub const DEFAULT_ARTIFACT_MAX_SIZE: u64 = 64 * 1024 * 1024;
pub const DEFAULT_ARTIFACT_MAX_TOTAL_BYTES: u64 = u64::MAX;
pub const MAX_ARTIFACT_RETENTION_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct ArtifactStoreConfig {
    pub max_size: u64,
    pub max_total_bytes: u64,
    pub retention_seconds: Option<u64>,
}

impl Default for ArtifactStoreConfig {
    fn default() -> Self {
        Self {
            max_size: DEFAULT_ARTIFACT_MAX_SIZE,
            max_total_bytes: DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
            retention_seconds: None,
        }
    }
}

impl ArtifactStoreConfig {
    pub fn validate(&self) -> Result<()> {
        if self.max_size == 0 {
            return Err(crate::Error::Invalid("产物大小上限必须大于零".into()));
        }
        if self.max_total_bytes < self.max_size {
            return Err(crate::Error::Invalid(
                "产物总配额不能小于单个产物大小上限".into(),
            ));
        }
        if self
            .retention_seconds
            .is_some_and(|value| value > MAX_ARTIFACT_RETENTION_SECONDS)
        {
            return Err(crate::Error::Invalid("产物保留期限超过允许范围".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Artifact {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub directory: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ArchivePage {
    pub entries: Vec<ArchiveEntry>,
    pub total: usize,
    pub next_offset: Option<usize>,
}
#[async_trait]
pub trait ArtifactStore: Send + Sync {
    async fn put(&self, filename: String, stream: ArtifactStream) -> Result<Artifact>;
    async fn get(&self, id: &str) -> Result<Artifact>;
    async fn delete(&self, id: &str) -> Result<Artifact>;
    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)>;
    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage>;
}
