//! 依赖声明随组件或完整发布分发，不绑定特定插件与宿主内部实现。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyManifest {
    pub format_version: u32,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
}

impl Default for DependencyManifest {
    fn default() -> Self {
        Self {
            format_version: 1,
            dependencies: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    pub name: String,
    pub version_requirement: String,
    #[serde(default = "required")]
    pub required: bool,
    pub entries: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub discovery: Vec<DiscoveryRule>,
    #[serde(default)]
    pub probe: Option<VersionProbe>,
    #[serde(default)]
    pub sources: Vec<DependencySource>,
    #[serde(default)]
    pub bindings: Vec<DependencyBinding>,
}

fn required() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryKind {
    Environment,
    Path,
    UserDirectory,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryRule {
    pub kind: DiscoveryKind,
    /// 环境变量名、PATH 程序名，或相对于宿主用户根的位置。
    pub value: String,
    /// 环境变量为文件时可用单入口的点号；PATH 候选相对程序所在目录。
    pub entries: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VersionProbe {
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 正则表达式的第一个捕获组必须是实际版本。
    pub pattern: String,
    #[serde(default = "probe_timeout")]
    pub timeout_ms: u64,
}

fn probe_timeout() -> u64 {
    3_000
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Market,
    Official,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    Tgz,
    File,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencySource {
    pub kind: SourceKind,
    pub url: String,
    pub platform: String,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub format: ArchiveFormat,
    pub entries: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyBinding {
    /// 独立组件可以省略，表示声明所属组件。
    #[serde(default)]
    pub component_id: String,
    pub config_pointer: String,
    pub entry: String,
}
