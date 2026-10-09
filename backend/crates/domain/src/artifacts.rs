use crate::Result;
use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

pub type ArtifactStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;
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
    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)>;
    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage>;
}
