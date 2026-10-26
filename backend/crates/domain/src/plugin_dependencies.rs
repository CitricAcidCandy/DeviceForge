//! 统一插件依赖查询与管理端口，不依赖文件系统、网络或工具进程。
use crate::{ExecutionContext, ProgressReporter, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub use deviceforge_plugin_dependencies::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DependencyTargetKind { Release, Server, Browser }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyTarget {
    pub kind: DependencyTargetKind,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DependencyStatus { Ready, Missing, Incompatible, Failed }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DependencyOrigin { Environment, Shared, Local }

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DependencyView {
    pub id: String,
    pub name: String,
    pub version_requirement: String,
    pub required: bool,
    pub status: DependencyStatus,
    pub source: Option<DependencyOrigin>,
    pub version: Option<String>,
    pub installable: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PluginDependencies {
    pub target: DependencyTarget,
    pub revision: String,
    pub dependencies: Vec<DependencyView>,
    pub ready: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyChange {
    pub expected_revision: String,
    #[serde(default)]
    pub dependency_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyRequest {
    pub target: DependencyTarget,
    pub expected_revision: String,
    #[serde(default)]
    pub dependency_ids: Vec<String>,
}

#[async_trait]
pub trait DependencyStore: Send + Sync {
    async fn get(&self, target: DependencyTarget) -> Result<PluginDependencies>;
    async fn scan(&self, request: DependencyRequest, cancel: CancellationToken,
        context: ExecutionContext, progress: Arc<dyn ProgressReporter>) -> Result<PluginDependencies>;
    async fn install(&self, request: DependencyRequest, cancel: CancellationToken,
        context: ExecutionContext, progress: Arc<dyn ProgressReporter>) -> Result<PluginDependencies>;
}
