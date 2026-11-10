//! 指南快照与下载缓存端口；不依赖网络、路径或宿主业务。
use crate::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub const MAX_GUIDE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuideDocument {
    pub target: String,
    pub topic: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuideSnapshot {
    pub format_version: u32,
    /// 兼容基线必须等于宿主内置知识版本；文字修订不提高此值。
    pub compatibility_version: u32,
    pub guide_version: u32,
    /// 文档数组确定性序列化后的SHA-256，不包含版本及摘要自身。
    pub content_sha256: String,
    pub documents: Vec<GuideDocument>,
}

/// 端口只传字节；完整语义校验及当前快照切换归应用层。
#[async_trait]
pub trait GuideStore: Send + Sync {
    async fn load(&self, deadline: Instant, cancel: CancellationToken) -> Result<Option<Vec<u8>>>;
    async fn download(&self, deadline: Instant, cancel: CancellationToken) -> Result<Vec<u8>>;
    /// 准备失败保留此前缓存；原子提交未确认须报错，不冒充回滚或自动重试。
    async fn save(
        &self,
        bytes: Vec<u8>,
        deadline: Instant,
        cancel: CancellationToken,
    ) -> Result<()>;
}
