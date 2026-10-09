//! 设备提供者的公开离散任务契约，不依赖宿主内部实现。
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEVICE_API_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityScope {
    Provider,
    Device,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceCapability {
    pub id: String,
    pub version: u32,
    pub operation: String,
    pub scope: CapabilityScope,
    pub access: CapabilityAccess,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceProviderAccess {
    pub api_version: u32,
    pub platform: String,
    pub discover_operation: String,
    pub capabilities: Vec<DeviceCapability>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    Online,
    Offline,
    Unauthorized,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityAvailability {
    pub id: String,
    pub version: u32,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginDevice {
    pub id: String,
    pub state: DeviceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub capabilities: Vec<CapabilityAvailability>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceActionInput {
    pub device_id: Option<String>,
    pub input: Value,
}
