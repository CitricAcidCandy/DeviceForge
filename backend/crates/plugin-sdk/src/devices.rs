//! 设备提供者的公开离散任务契约，不依赖宿主内部实现。
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEVICE_API_VERSION: u32 = 3;

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
    /// API 2/3 的能力总预算；省略或 null 默认 30000，宿主最多允许 120000 毫秒。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_timeout_ms: Option<u64>,
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
    /// API 3 的原始状态；宿主按声明版本校验，不用于替代归一化状态或动作准入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_state: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_state_omission_and_null_keep_legacy_device_serialization() {
        let value = serde_json::json!({"id":"sample","state":"unknown","capabilities":[]});
        let device: PluginDevice = serde_json::from_value(value.clone()).unwrap();
        assert!(device.raw_state.is_none());
        assert_eq!(serde_json::to_value(device).unwrap(), value);

        let mut explicit = value.clone();
        explicit["raw_state"] = Value::Null;
        let device: PluginDevice = serde_json::from_value(explicit).unwrap();
        assert!(device.raw_state.is_none());
        assert_eq!(serde_json::to_value(device).unwrap(), value);
    }

    #[test]
    fn raw_state_keeps_exact_text_and_rejects_non_string_wire_values() {
        let mut value = serde_json::json!({"id":"sample","state":"unknown","capabilities":[]});
        let raw = " Vendor.Recovery 模式 ";
        value["raw_state"] = serde_json::json!(raw);
        let device: PluginDevice = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(device.raw_state.as_deref(), Some(raw));
        assert!(matches!(device.state, DeviceState::Unknown));
        assert_eq!(serde_json::to_value(device).unwrap(), value);

        for invalid in [
            serde_json::json!(1),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            value["raw_state"] = invalid;
            assert!(serde_json::from_value::<PluginDevice>(value.clone()).is_err());
        }
    }

    #[test]
    fn omitted_and_null_budgets_keep_legacy_serialization_and_invalid_numbers_fail() {
        let value = serde_json::json!({"id":"install","version":1,"operation":"install","scope":"device","access":"write"});
        let original: DeviceCapability = serde_json::from_value(value.clone()).unwrap();
        assert!(original.execution_timeout_ms.is_none());
        assert_eq!(serde_json::to_value(original).unwrap(), value);
        let mut explicit = value.clone();
        explicit["execution_timeout_ms"] = Value::Null;
        let null: DeviceCapability = serde_json::from_value(explicit.clone()).unwrap();
        assert!(null.execution_timeout_ms.is_none());
        for invalid in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("120000"),
        ] {
            explicit["execution_timeout_ms"] = invalid;
            assert!(serde_json::from_value::<DeviceCapability>(explicit.clone()).is_err());
        }
    }
}
