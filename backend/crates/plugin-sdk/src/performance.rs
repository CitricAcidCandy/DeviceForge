//! 性能声明的纯版本与绑定资格；协议、提供者和贡献关联由宿主装载层校验。
use serde::{Deserialize, Serialize};
mod observation;
pub use observation::{
    BatteryElectricalObservation, BatteryStatus, BatterySupplyState, CurrentPolarity,
    DeviceObservation, DeviceTemperature, ObservationAccess, ObservationScope, TemperatureKind,
};

pub const LEGACY_PERFORMANCE_API_VERSION: u32 = 1;
pub const DEVICE_PERFORMANCE_API_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceDeviceCapability {
    pub id: String,
    pub version: u32,
}

impl PerformanceDeviceCapability {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 100
            || self.id.starts_with('-')
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-[]".contains(&byte))
            || self.version == 0
        {
            return Err("性能设备能力引用的标识或版本无效");
        }
        Ok(())
    }
}

/// API 1 保留旧独立探针，API 2 显式引用同插件设备采样能力。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "Declaration")]
pub struct PerformanceAccess {
    #[serde(skip_serializing_if = "legacy_version")]
    pub api_version: u32,
    pub sample_operation: String,
    pub fps: bool,
    #[serde(default, skip_serializing_if = "false_observation")]
    pub device_observation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_capability: Option<PerformanceDeviceCapability>,
}

impl PerformanceAccess {
    /// 同时覆盖 Rust 字面量；反序列化也调用此纯规则。
    pub fn validate(&self) -> Result<(), &'static str> {
        match (self.api_version, &self.device_capability) {
            (LEGACY_PERFORMANCE_API_VERSION, None) => Ok(()),
            (DEVICE_PERFORMANCE_API_VERSION, Some(binding)) => binding.validate(),
            (LEGACY_PERFORMANCE_API_VERSION, Some(_)) => Err("性能声明 API 1 不能绑定设备能力"),
            (DEVICE_PERFORMANCE_API_VERSION, None) => Err("性能声明 API 2 必须绑定设备能力"),
            _ => Err("性能声明版本必须为 1 或 2"),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declaration {
    #[serde(default = "default_version")]
    api_version: u32,
    sample_operation: String,
    #[serde(default)]
    fps: bool,
    #[serde(default)]
    device_observation: bool,
    #[serde(default)]
    device_capability: Option<PerformanceDeviceCapability>,
}

impl TryFrom<Declaration> for PerformanceAccess {
    type Error = &'static str;

    fn try_from(value: Declaration) -> Result<Self, Self::Error> {
        let access = Self {
            api_version: value.api_version,
            sample_operation: value.sample_operation,
            fps: value.fps,
            device_observation: value.device_observation,
            device_capability: value.device_capability,
        };
        access.validate()?;
        Ok(access)
    }
}

fn default_version() -> u32 {
    LEGACY_PERFORMANCE_API_VERSION
}

fn legacy_version(value: &u32) -> bool {
    *value == LEGACY_PERFORMANCE_API_VERSION
}

#[cfg(test)]
mod tests;

fn false_observation(value: &bool) -> bool {
    !*value
}
