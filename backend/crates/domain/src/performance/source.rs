use crate::devices::DeviceRef;
use serde::{Deserialize, Serialize};
mod rules;

/// 设备型采样只引用同一提供者的精确能力，不以平台名称推断。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerformanceDeviceCapability {
    pub id: String,
    pub version: u32,
}

/// 执行器提供的来源声明；完整操作标识在注册时验证。
#[derive(Clone, Debug)]
pub struct PerformanceSourceDefinition {
    pub api_version: u32,
    pub operation: String,
    pub fps: bool,
    pub device_observation: bool,
    pub device_capability: Option<PerformanceDeviceCapability>,
}

impl PerformanceSourceDefinition {
    /// 注册和独立适配器共用资格规则，不信任自定义执行器的声明。
    pub fn validate(
        &self,
        plugin_id: &str,
        operations: &[crate::Operation],
        provider: Option<&crate::devices::DeviceProviderDefinition>,
    ) -> crate::Result<()> {
        rules::definition(self, plugin_id, operations, provider)
    }
}

/// 会话创建时固定的来源归属；重载不得将旧历史改为新代。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceSourceRef {
    pub plugin_id: String,
    pub generation: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceRef>,
}

#[cfg(test)]
mod tests;
