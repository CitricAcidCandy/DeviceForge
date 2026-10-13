//! 私有原始观测到公开合同的纯映射；不合并跨来源电压/电流，不计算功率。
use super::{BatteryState, Check, EnvironmentObservation, Observed, Result, UeventBattery};
use apk_plugin_sdk::{
    BatteryElectricalObservation, BatteryStatus, BatterySupplyState, CurrentPolarity,
    DeviceObservation, DeviceTemperature, ObservationAccess, ObservationScope, TemperatureKind,
};

fn status(state: Option<BatteryState>) -> Option<BatteryStatus> {
    state.map(|state| match state {
        BatteryState::Unknown => BatteryStatus::Unknown,
        BatteryState::Charging => BatteryStatus::Charging,
        BatteryState::Discharging => BatteryStatus::Discharging,
        BatteryState::NotCharging => BatteryStatus::NotCharging,
        BatteryState::Full => BatteryStatus::Full,
    })
}

fn supply(raw: &EnvironmentObservation) -> BatterySupplyState {
    match raw
        .battery_service
        .as_ref()
        .and_then(|observed| observed.value.external_powered)
    {
        Some(true) => BatterySupplyState::External,
        Some(false) => BatterySupplyState::Battery,
        None => BatterySupplyState::Unknown,
    }
}

fn polarity(
    current: Option<i64>,
    state: Option<BatteryState>,
    external_powered: Option<bool>,
) -> CurrentPolarity {
    let Some(current) = current else {
        return CurrentPolarity::Unknown;
    };
    let conflict = match state {
        Some(BatteryState::Charging) => current < 0,
        Some(BatteryState::Discharging) => current > 0,
        Some(BatteryState::NotCharging | BatteryState::Full) => current != 0,
        Some(BatteryState::Unknown) | None => false,
    } || (external_powered == Some(false) && current > 0);
    if conflict {
        CurrentPolarity::Unknown
    } else {
        CurrentPolarity::PositiveCharging
    }
}

fn voltage(value: Option<i64>) -> Option<u64> {
    value
        .filter(|value| (1..=50_000_000).contains(value))
        .and_then(|value| u64::try_from(value).ok())
}

fn sysfs_battery(
    observed: &Observed<UeventBattery>,
    raw: &EnvironmentObservation,
) -> Option<BatteryElectricalObservation> {
    let value = &observed.value;
    if value.present == Some(false)
        || value.fields.get("POWER_SUPPLY_TYPE").map(String::as_str) != Some("Battery")
    {
        return None;
    }
    let voltage_uv = voltage(value.voltage_uv)?;
    let current_ua = value
        .current_raw_ua
        .filter(|value| (-100_000_000..=100_000_000).contains(value));
    let external = raw
        .battery_service
        .as_ref()
        .and_then(|observed| observed.value.external_powered);
    Some(BatteryElectricalObservation {
        observed_at: observed.observed_at,
        source: "battery_sysfs_uevent".into(),
        access: ObservationAccess::AdbShell,
        voltage_uv,
        current_ua,
        current_polarity: polarity(current_ua, value.state, external),
        status: status(value.state),
        supply_state: supply(raw),
    })
}

fn battery(raw: &EnvironmentObservation) -> Option<BatteryElectricalObservation> {
    if let Some(value) = raw
        .sysfs_battery
        .as_ref()
        .and_then(|observed| sysfs_battery(observed, raw))
    {
        return Some(value);
    }
    let observed = raw.battery_service.as_ref()?;
    let value = &observed.value;
    if value.present == Some(false) {
        return None;
    }
    let voltage_uv = voltage(value.voltage_mv.and_then(|value| value.checked_mul(1000)))?;
    Some(BatteryElectricalObservation {
        observed_at: observed.observed_at,
        source: "battery_dumpsys".into(),
        access: ObservationAccess::AdbShell,
        voltage_uv,
        current_ua: None,
        current_polarity: CurrentPolarity::Unknown,
        status: status(value.state),
        supply_state: supply(raw),
    })
}

fn temperature(observed_at: u64, source: &str, decicelsius: i64) -> Option<DeviceTemperature> {
    let temperature_celsius = decicelsius as f64 / 10.0;
    if !(-273.15..=400.0).contains(&temperature_celsius) {
        return None;
    }
    Some(DeviceTemperature {
        observed_at,
        source: source.into(),
        access: ObservationAccess::AdbShell,
        sensor_kind: TemperatureKind::Battery,
        sensor_name: "battery".into(),
        sensor_type: None,
        temperature_celsius,
        status: None,
    })
}

fn battery_temperature(raw: &EnvironmentObservation) -> Option<DeviceTemperature> {
    if let Some(value) = raw.sysfs_battery.as_ref().and_then(|observed| {
        let value = &observed.value;
        (value.present != Some(false)
            && value.fields.get("POWER_SUPPLY_TYPE").map(String::as_str) == Some("Battery"))
        .then(|| {
            value
                .temperature_decicelsius
                .and_then(|value| temperature(observed.observed_at, "battery_sysfs_uevent", value))
        })
        .flatten()
    }) {
        return Some(value);
    }
    let observed = raw.battery_service.as_ref()?;
    if observed.value.present == Some(false) {
        return None;
    }
    temperature(
        observed.observed_at,
        "battery_dumpsys",
        observed.value.temperature_decicelsius?,
    )
}

pub(crate) fn observation(
    raw: EnvironmentObservation,
    device_id: String,
    check: Check<'_>,
) -> Result<Option<DeviceObservation>> {
    check()?;
    let battery = battery(&raw);
    let mut temperatures = Vec::new();
    for observed in &raw.temperatures {
        check()?;
        let value = &observed.value;
        let sensor_kind = match value.sensor_type {
            0 => TemperatureKind::Cpu,
            1 => TemperatureKind::Gpu,
            2 => TemperatureKind::Battery,
            3 => TemperatureKind::Skin,
            _ => continue,
        };
        if !(-273.15..=400.0).contains(&value.value_celsius) {
            continue;
        }
        temperatures.push(DeviceTemperature {
            observed_at: observed.observed_at,
            source: "thermal_hal_current".into(),
            access: ObservationAccess::AdbShell,
            sensor_kind,
            sensor_name: value.name.clone(),
            sensor_type: Some(value.sensor_type),
            temperature_celsius: value.value_celsius,
            status: Some(u32::from(value.throttling_status)),
        });
    }
    if !temperatures
        .iter()
        .any(|value| value.sensor_kind == TemperatureKind::Battery)
        && let Some(value) = battery_temperature(&raw)
    {
        temperatures.push(value);
    }
    if temperatures.len() > 32 {
        return Err(super::Error::TooLarge);
    }
    check()?;
    if battery.is_none() && temperatures.is_empty() {
        return Ok(None);
    }
    Ok(Some(DeviceObservation {
        api_version: 1,
        scope: ObservationScope::Device,
        device_id,
        battery,
        temperatures,
    }))
}

#[cfg(test)]
mod tests;
