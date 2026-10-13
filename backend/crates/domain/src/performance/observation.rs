//! 可选设备观测的版本、单位与资格；不执行设备调用或补造缺测值。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationScope {
    Device,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationAccess {
    AdbShell,
    RootShell,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CurrentPolarity {
    PositiveCharging,
    PositiveDischarging,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BatteryStatus {
    Unknown,
    Charging,
    Discharging,
    NotCharging,
    Full,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BatterySupplyState {
    Battery,
    External,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TemperatureKind {
    Cpu,
    Gpu,
    Battery,
    Skin,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceObservation {
    pub api_version: u32,
    pub scope: ObservationScope,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery: Option<BatteryElectricalObservation>,
    pub temperatures: Vec<DeviceTemperature>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BatteryElectricalObservation {
    pub observed_at: u64,
    pub source: String,
    pub access: ObservationAccess,
    /// 原值统一为微伏，不混用 Health HAL 的毫伏。
    pub voltage_uv: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_ua: Option<i64>,
    pub current_polarity: CurrentPolarity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<BatteryStatus>,
    pub supply_state: BatterySupplyState,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeviceTemperature {
    pub observed_at: u64,
    pub source: String,
    pub access: ObservationAccess,
    pub sensor_kind: TemperatureKind,
    pub sensor_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensor_type: Option<i32>,
    /// 仅明确温度量纲的来源可填，热状态和 BCL 数值不转成摄氏度。
    pub temperature_celsius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
}

fn source(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
}
fn observed_at(value: u64, captured_at: u64) -> bool {
    value <= captured_at && value >= captured_at.saturating_sub(10_000)
}
impl DeviceObservation {
    pub fn validate(&self, captured_at: u64) -> Result<(), &'static str> {
        if self.api_version != 1
            || self.device_id.trim().is_empty()
            || self.device_id.len() > 200
            || self.device_id.starts_with('-')
            || self.device_id.chars().any(char::is_control)
        {
            return Err("设备观测版本或设备标识无效");
        }
        if self.temperatures.len() > 32 || self.battery.is_none() && self.temperatures.is_empty() {
            return Err("设备观测为空或传感器数量超限");
        }
        if let Some(battery) = &self.battery {
            battery.validate(captured_at)?;
        }
        let mut identities = std::collections::HashSet::new();
        for temperature in &self.temperatures {
            temperature.validate(captured_at)?;
            if !identities.insert((
                &temperature.source,
                temperature.sensor_type,
                &temperature.sensor_name,
            )) {
                return Err("温度传感器身份重复");
            }
        }
        Ok(())
    }
}

impl BatteryElectricalObservation {
    fn normalized_current(&self) -> Option<i64> {
        match self.current_polarity {
            CurrentPolarity::PositiveCharging => self.current_ua,
            CurrentPolarity::PositiveDischarging => self.current_ua.and_then(i64::checked_neg),
            CurrentPolarity::Unknown => None,
        }
    }
    /// 有符号整机净电池功率；充电为正、放电为负，未知极性保持缺测。
    pub fn net_power_mw(&self) -> Option<f64> {
        self.normalized_current()
            .map(|current| self.voltage_uv as f64 * current as f64 / 1_000_000_000.0)
    }
    fn validate(&self, captured_at: u64) -> Result<(), &'static str> {
        if !source(&self.source)
            || !observed_at(self.observed_at, captured_at)
            || !(1..=50_000_000).contains(&self.voltage_uv)
            || self
                .current_ua
                .is_some_and(|current| !(-100_000_000..=100_000_000).contains(&current))
            || self.current_ua.is_none() && self.current_polarity != CurrentPolarity::Unknown
        {
            return Err("电池观测单位、时间、来源或极性无效");
        }
        if let Some(current) = self.normalized_current()
            && (matches!(self.status, Some(BatteryStatus::Charging)) && current < 0
                || matches!(self.status, Some(BatteryStatus::Discharging)) && current > 0
                || self.supply_state == BatterySupplyState::Battery && current > 0)
        {
            return Err("电池电流与状态或供电资格矛盾");
        }
        Ok(())
    }
}
impl DeviceTemperature {
    fn validate(&self, captured_at: u64) -> Result<(), &'static str> {
        if !source(&self.source)
            || !observed_at(self.observed_at, captured_at)
            || self.sensor_name.is_empty()
            || self.sensor_name.len() > 128
            || self.sensor_name.chars().any(char::is_control)
            || self.sensor_name.contains('\u{fffd}')
            || !self.temperature_celsius.is_finite()
            || !(-273.15..=400.0).contains(&self.temperature_celsius)
            || self.status.is_some_and(|status| status > 6)
        {
            return Err("温度观测来源、时间、传感器或数值无效");
        }
        if let Some(kind) = self.sensor_type {
            let expected = match kind {
                0 => TemperatureKind::Cpu,
                1 => TemperatureKind::Gpu,
                2 => TemperatureKind::Battery,
                3 => TemperatureKind::Skin,
                4..=64 if !(6..=8).contains(&kind) => TemperatureKind::Other,
                _ => return Err("传感器不是可用摄氏温度类型"),
            };
            if expected != self.sensor_kind {
                return Err("传感器原类型与类别不一致");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
