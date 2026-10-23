//! 统一发布清单、安装状态与可替换存储端口；不依赖 HTTP 和本机路径操作。
mod validation;
pub use validation::{validate_release_digest, validate_release_path};
#[cfg(test)]
mod tests;
use crate::{
    Operation, Result,
    plugin_packages::{PackageAsset, PackageKind},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const RELEASE_MANIFEST_LIMIT: usize = 256 * 1024;
pub const RELEASE_RESOURCE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
pub const RELEASE_OFFLINE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceFormat {
    Zip,
    Tgz,
    File,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseManifest {
    pub format_version: u32,
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub host_api_version: u32,
    pub components: Vec<ReleaseComponent>,
    #[serde(default)]
    pub tools: Vec<ReleaseTool>,
    #[serde(default)]
    pub requirements: Vec<ReleaseRequirement>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseComponent {
    pub id: String,
    pub kind: PackageKind,
    pub version: String,
    pub variants: Vec<ComponentVariant>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ComponentVariant {
    pub platform: String,
    /// 相对于 release.json 的 URL，或离线发布归档内的相对路径。
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub format: ResourceFormat,
}

fn required_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseTool {
    pub id: String,
    pub version: String,
    #[serde(default = "required_by_default")]
    pub required: bool,
    pub variants: Vec<ToolVariant>,
    #[serde(default)]
    pub bindings: Vec<ToolBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolVariant {
    pub platform: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub format: ResourceFormat,
    /// 稳定资源键到归档内相对普通文件；file 格式仅允许 payload。
    pub entries: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolBinding {
    pub component_id: String,
    pub config_pointer: String,
    pub entry: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseRequirement {
    pub component_id: String,
    pub config_pointer: String,
    /// 同一输入声明的额外候选路径，主路径或任意候选填写即可满足。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub any_of: Vec<String>,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub sensitive: bool,
    #[serde(default = "required_by_default")]
    pub required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InstallSource {
    Market {
        source_url: String,
        release_id: String,
        version: String,
        manifest_sha256: String,
    },
    Offline {
        artifact_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallationStatus {
    Installed,
    Enabled,
    ConfigurationRequired,
    RecoveryBlocked,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InstallationFailure {
    pub phase: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InstalledComponent {
    pub id: String,
    pub kind: PackageKind,
    pub version: String,
    pub revision: String,
    pub entry_path: String,
    pub entry_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InstalledTool {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub sha256: String,
    /// 只公开稳定资源键，不把本机绝对路径混入安装视图。
    pub entries: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InstalledRelease {
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    /// release.json 原始字节的 SHA-256，也是活动版本的 CAS 标识。
    pub revision: String,
    pub enabled: bool,
    pub status: InstallationStatus,
    #[serde(default)]
    pub failure: Option<InstallationFailure>,
    pub installed_at: u64,
    pub components: Vec<InstalledComponent>,
    pub tools: Vec<InstalledTool>,
    pub requirements: Vec<ReleaseRequirement>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationRevision {
    pub expected_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationEnabled {
    pub expected_revision: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InstallationPlan {
    pub id: String,
    pub version: String,
    pub revision: String,
    pub actions: Vec<PlanAction>,
    pub issues: Vec<PlanIssue>,
    pub resources: Vec<PlanResource>,
    pub download_size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PlanResource {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub platform: String,
    pub sha256: String,
    pub size: u64,
    pub reused: bool,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    Download,
    Reuse,
    Verify,
    Install,
    PreservePrevious,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PlanIssue {
    pub code: String,
    pub message: String,
    pub required: bool,
}

/// 仅宿主内部不可变资源文件使用绝对路径，HTTP 安装视图不返回此结构。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceBindings {
    pub format_version: u32,
    pub release_id: String,
    pub revision: String,
    pub tools: BTreeMap<String, BoundTool>,
    pub bindings: Vec<ResourceBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceBinding {
    pub tool_id: String,
    pub component_id: String,
    pub config_pointer: String,
    pub entry: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoundTool {
    pub version: String,
    pub platform: String,
    pub entries: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ResourceCleanupItem {
    /// 安装器产生的相对资源标识，不接受客户端指定任意文件路径。
    pub resource: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ResourceCleanupReport {
    pub dry_run: bool,
    pub items: Vec<ResourceCleanupItem>,
    pub total_bytes: u64,
}

#[async_trait]
pub trait PreparedInstallation: Send {
    fn info(&self) -> &InstalledRelease;
    fn operations(&self) -> &[Operation];
    /// 全部资源先验证，调用方在生命周期门禁中提交并再次核对旧修订。
    async fn commit(self: Box<Self>, expected_revision: Option<String>)
    -> Result<InstalledRelease>;
}

#[async_trait]
pub trait InstallationStore: Send + Sync {
    async fn plan(&self, source: InstallSource) -> Result<InstallationPlan>;
    async fn prepare(&self, source: InstallSource) -> Result<Box<dyn PreparedInstallation>>;
    async fn prepare_with_progress(
        &self,
        source: InstallSource,
        _progress: std::sync::Arc<dyn crate::ProgressReporter>,
    ) -> Result<Box<dyn PreparedInstallation>> {
        self.prepare(source).await
    }
    async fn list(&self) -> Result<Vec<InstalledRelease>>;
    async fn get(&self, id: &str) -> Result<InstalledRelease>;
    async fn set_enabled(
        &self,
        id: &str,
        expected_revision: &str,
        enabled: bool,
    ) -> Result<InstalledRelease>;
    async fn configuration_required(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<InstalledRelease>;
    async fn recovery_blocked(
        &self,
        id: &str,
        expected_revision: &str,
        phase: &str,
        reason: &str,
    ) -> Result<InstalledRelease>;
    /// 删除时重新计算引用；运行中的组件与所有准备阶段资源必须受保护。
    async fn cleanup_resources(
        &self,
        dry_run: bool,
        running_components: Vec<String>,
    ) -> Result<ResourceCleanupReport>;
    async fn restore_previous(&self, id: &str, expected_revision: &str)
    -> Result<InstalledRelease>;
    /// 应用门禁要求用户先停用；安装回滚允许删除尚未激活的 Installed 记录。
    async fn delete(&self, id: &str, expected_revision: &str) -> Result<InstalledRelease>;
    async fn asset(&self, component_id: &str, revision: &str, path: &str) -> Result<PackageAsset>;
}
