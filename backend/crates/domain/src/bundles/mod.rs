use crate::{Error, ExecutionContext, Result, artifacts::Artifact};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BuildMode {
    Default,
    Universal,
}
impl BuildMode {
    pub fn argument(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Universal => "universal",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BuildApksRequest {
    #[schemars(regex(
        pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ))]
    pub artifact_id: String,
    pub mode: BuildMode,
}
impl BuildApksRequest {
    pub fn validate(&self) -> Result<()> {
        if self.artifact_id.len() != 36 {
            return Err(Error::Invalid("产物 ID 必须为规范 UUID".into()));
        }
        uuid::Uuid::parse_str(&self.artifact_id)
            .map_err(|_| Error::Invalid("产物 ID 必须为 UUID".into()))?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct BuiltApks {
    pub source_artifact_id: String,
    pub mode: BuildMode,
    pub artifact: Artifact,
    pub apk_count: usize,
    pub universal_entry: Option<String>,
}
#[async_trait]
pub trait BundleBuilder: Send + Sync {
    async fn build(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
    ) -> Result<BuiltApks>;

    /// 新适配器复用原绝对截止点；旧仅实现者默认保留原调用语义。
    async fn build_with_context(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
        _: ExecutionContext,
    ) -> Result<BuiltApks> {
        self.build(request, cancel).await
    }

    /// 未确认的工具清理和仍在执行的后台工作由适配器观测。
    fn has_unresolved_resources(&self) -> bool {
        false
    }
}
