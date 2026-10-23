//! 任务进度与状态转换独立；只携带有界阶段和资源标识，不携带本机路径。
use crate::{Error, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobStage {
    Preparing,
    Downloading,
    Verifying,
    Deploying,
    Activating,
    Complete,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct JobProgress {
    pub stage: JobStage,
    pub resource_id: Option<String>,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
}

impl JobProgress {
    pub fn validate(&self) -> Result<()> {
        if self
            .resource_id
            .as_ref()
            .is_some_and(|id| crate::identifier(id).is_err())
            || self
                .total_bytes
                .is_some_and(|total| self.completed_bytes > total)
        {
            return Err(Error::Invalid("任务进度字段无效".into()));
        }
        Ok(())
    }
    pub fn stage(stage: JobStage) -> Self {
        Self {
            stage,
            resource_id: None,
            completed_bytes: 0,
            total_bytes: None,
        }
    }
}

#[async_trait]
pub trait ProgressReporter: Send + Sync {
    async fn report(&self, progress: JobProgress) -> Result<()>;
}

pub struct NoProgress;
#[async_trait]
impl ProgressReporter for NoProgress {
    async fn report(&self, _: JobProgress) -> Result<()> {
        Ok(())
    }
}
