//! 插件配置声明与宿主管理配置文件的选择入口，不改变任务请求协议。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationApplyPolicy {
    #[default]
    NextInvocation,
    PluginReload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationDefinition {
    pub version: u32,
    pub schema: Value,
    pub defaults: Value,
    #[serde(default)]
    pub apply_policy: ConfigurationApplyPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_filename: Option<String>,
}

/// 已声明配置的插件优先读取宿主传入的不可变修订，未提供时沿用旧启动参数。
pub fn managed_config_path() -> Option<PathBuf> {
    std::env::var_os("DEVICEFORGE_PLUGIN_CONFIG")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}
