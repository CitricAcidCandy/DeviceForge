//! 宿主设备身份与能力目录；平台协议消息由基础设施命名映射进入此边界。
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod rules;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityScope {
    Provider,
    Device,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceCapability {
    pub id: String,
    pub version: u32,
    pub operation: String,
    pub scope: CapabilityScope,
    pub access: CapabilityAccess,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceProviderDefinition {
    pub api_version: u32,
    pub platform: String,
    pub discover_operation: String,
    pub capabilities: Vec<DeviceCapability>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceProviderInfo {
    pub id: String,
    pub generation: String,
    pub version: String,
    pub definition: DeviceProviderDefinition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceRef {
    pub provider_id: String,
    pub generation: String,
    pub local_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    Online,
    Offline,
    Unauthorized,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilityAvailability {
    pub id: String,
    pub version: u32,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProvidedDevice {
    pub reference: DeviceRef,
    pub state: DeviceState,
    pub model: Option<String>,
    pub capabilities: Vec<CapabilityAvailability>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceDirectory {
    pub provider: DeviceProviderInfo,
    pub observed_at: u64,
    pub discovery_job_id: String,
    pub devices: Vec<ProvidedDevice>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderInput {
    pub id: String,
    pub generation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceActionRequest {
    pub provider_id: String,
    pub generation: String,
    pub device_id: Option<String>,
    pub capability: String,
    pub version: u32,
    pub input: Value,
}
