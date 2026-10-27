//! npm 与 ZIP 共用的便携包声明；运行入口由宿主映射。
use crate::{ArtifactAccess, Contribution, PerformanceAccess, SessionAccess};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PortablePackage {
    pub version: String,
    pub deviceforge: PackageDescriptor,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageDescriptor {
    pub kind: String,
    pub manifest: String,
    pub entrypoints: BTreeMap<String, PackageEntrypoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageEntrypoint {
    pub runtime: String,
    pub path: String,
    /// 脚本入口通过统一依赖快照选择运行时，不在包中保存机器程序路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<RuntimeDependency>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDependency {
    pub id: String,
    pub entry: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableServerManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services: Option<crate::services::ServiceAccess>,
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<crate::recovery::RecoveryAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<crate::ConfigurationDefinition>,
    pub protocol_version: u32,
    #[serde(default)]
    pub args: Vec<String>,
    pub operations: Vec<Contribution>,
    /// 包入口映射后原样保留独立会话声明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<SessionAccess>,
    #[serde(default)]
    pub artifacts: Option<ArtifactAccess>,
    #[serde(default)]
    pub performance: Option<PerformanceAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<crate::devices::DeviceProviderAccess>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserManifest {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<crate::ConfigurationDefinition>,
    pub api_version: u32,
}
