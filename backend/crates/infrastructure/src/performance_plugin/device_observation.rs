//! 公开插件设备观测到领域类型的显式纯映射；不采集或计算设备数值。
use apk_domain::performance as domain;
use apk_plugin_sdk as sdk;
fn access(value: sdk::ObservationAccess) -> domain::ObservationAccess {
    match value {
        sdk::ObservationAccess::AdbShell => domain::ObservationAccess::AdbShell,
        sdk::ObservationAccess::RootShell => domain::ObservationAccess::RootShell,
    }
}
fn polarity(value: sdk::CurrentPolarity) -> domain::CurrentPolarity {
    match value {
        sdk::CurrentPolarity::PositiveCharging => domain::CurrentPolarity::PositiveCharging,
        sdk::CurrentPolarity::PositiveDischarging => domain::CurrentPolarity::PositiveDischarging,
        sdk::CurrentPolarity::Unknown => domain::CurrentPolarity::Unknown,
    }
}
fn status(value: sdk::BatteryStatus) -> domain::BatteryStatus {
    match value {
        sdk::BatteryStatus::Unknown => domain::BatteryStatus::Unknown,
        sdk::BatteryStatus::Charging => domain::BatteryStatus::Charging,
        sdk::BatteryStatus::Discharging => domain::BatteryStatus::Discharging,
        sdk::BatteryStatus::NotCharging => domain::BatteryStatus::NotCharging,
        sdk::BatteryStatus::Full => domain::BatteryStatus::Full,
    }
}
fn supply(value: sdk::BatterySupplyState) -> domain::BatterySupplyState {
    match value {
        sdk::BatterySupplyState::Battery => domain::BatterySupplyState::Battery,
        sdk::BatterySupplyState::External => domain::BatterySupplyState::External,
        sdk::BatterySupplyState::Unknown => domain::BatterySupplyState::Unknown,
    }
}
fn kind(value: sdk::TemperatureKind) -> domain::TemperatureKind {
    match value {
        sdk::TemperatureKind::Cpu => domain::TemperatureKind::Cpu,
        sdk::TemperatureKind::Gpu => domain::TemperatureKind::Gpu,
        sdk::TemperatureKind::Battery => domain::TemperatureKind::Battery,
        sdk::TemperatureKind::Skin => domain::TemperatureKind::Skin,
        sdk::TemperatureKind::Other => domain::TemperatureKind::Other,
    }
}
pub(super) fn map(value: sdk::DeviceObservation) -> domain::DeviceObservation {
    domain::DeviceObservation {
        api_version: value.api_version,
        scope: domain::ObservationScope::Device,
        device_id: value.device_id,
        battery: value
            .battery
            .map(|battery| domain::BatteryElectricalObservation {
                observed_at: battery.observed_at,
                source: battery.source,
                access: access(battery.access),
                voltage_uv: battery.voltage_uv,
                current_ua: battery.current_ua,
                current_polarity: polarity(battery.current_polarity),
                status: battery.status.map(status),
                supply_state: supply(battery.supply_state),
            }),
        temperatures: value
            .temperatures
            .into_iter()
            .map(|temperature| domain::DeviceTemperature {
                observed_at: temperature.observed_at,
                source: temperature.source,
                access: access(temperature.access),
                sensor_kind: kind(temperature.sensor_kind),
                sensor_name: temperature.sensor_name,
                sensor_type: temperature.sensor_type,
                temperature_celsius: temperature.temperature_celsius,
                status: temperature.status,
            })
            .collect(),
    }
}
