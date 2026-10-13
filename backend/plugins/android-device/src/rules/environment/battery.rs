//! 固定电池节点与 BatteryService 输出；不将充电上限当成实际电流。
use super::{BatteryService, BatteryState, Check, Error, Result, UeventBattery, clean, integer};
use std::collections::BTreeMap;

fn boolean(value: &str) -> Option<bool> {
    match value {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn sysfs_state(value: &str) -> Option<BatteryState> {
    match value {
        "Unknown" => Some(BatteryState::Unknown),
        "Charging" => Some(BatteryState::Charging),
        "Discharging" => Some(BatteryState::Discharging),
        "Not charging" => Some(BatteryState::NotCharging),
        "Full" => Some(BatteryState::Full),
        _ => None,
    }
}

pub(crate) fn battery_uevent(output: &str, check: Check<'_>) -> Result<Option<UeventBattery>> {
    check()?;
    if !clean(output) {
        return Ok(None);
    }
    let mut fields = BTreeMap::new();
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= 128 {
            return Err(Error::TooLarge);
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Ok(None);
        };
        if !key.starts_with("POWER_SUPPLY_")
            || key.len() > 80
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || value.len() > 512
            || value.chars().any(char::is_control)
            || fields.insert(key.to_owned(), value.to_owned()).is_some()
        {
            return Ok(None);
        }
    }
    if fields.get("POWER_SUPPLY_NAME").map(String::as_str) != Some("battery")
        || fields.get("POWER_SUPPLY_TYPE").map(String::as_str) != Some("Battery")
    {
        return Ok(None);
    }
    let get = |key| fields.get(key).map(String::as_str);
    let result = UeventBattery {
        present: get("POWER_SUPPLY_PRESENT").and_then(boolean),
        state: get("POWER_SUPPLY_STATUS").and_then(sysfs_state),
        voltage_uv: get("POWER_SUPPLY_VOLTAGE_NOW")
            .and_then(integer)
            .filter(|value| *value > 0),
        current_raw_ua: get("POWER_SUPPLY_CURRENT_NOW").and_then(integer),
        temperature_decicelsius: get("POWER_SUPPLY_TEMP").and_then(integer),
        fields,
    };
    check()?;
    Ok(Some(result))
}

pub(crate) fn battery_service(output: &str, check: Check<'_>) -> Result<Option<BatteryService>> {
    check()?;
    if !clean(output) || output.contains("UPDATES STOPPED") {
        // BatteryService 的调试覆盖不作为真实电气或温度观测，且不自动 reset。
        return Ok(None);
    }
    let mut header = false;
    let mut fields = BTreeMap::new();
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= 512 {
            return Err(Error::TooLarge);
        }
        let line = line.trim();
        if line == "Current Battery Service state:" {
            if header {
                return Ok(None);
            }
            header = true;
            continue;
        }
        if !header || line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Ok(None);
        };
        if matches!(
            key,
            "AC powered"
                | "USB powered"
                | "Wireless powered"
                | "Dock powered"
                | "status"
                | "present"
                | "voltage"
                | "temperature"
        ) && fields.insert(key, value.trim()).is_some()
        {
            return Ok(None);
        }
    }
    if !header {
        return Ok(None);
    }
    let get = |key| fields.get(key).copied();
    let powered = [
        "AC powered",
        "USB powered",
        "Wireless powered",
        "Dock powered",
    ]
    .map(|key| get(key).and_then(boolean));
    let external_powered = if powered.contains(&Some(true)) {
        Some(true)
    } else if powered.iter().all(|value| *value == Some(false)) {
        Some(false)
    } else {
        None
    };
    let state = match get("status").and_then(integer) {
        Some(1) => Some(BatteryState::Unknown),
        Some(2) => Some(BatteryState::Charging),
        Some(3) => Some(BatteryState::Discharging),
        Some(4) => Some(BatteryState::NotCharging),
        Some(5) => Some(BatteryState::Full),
        _ => None,
    };
    check()?;
    Ok(Some(BatteryService {
        present: get("present").and_then(boolean),
        state,
        external_powered,
        voltage_mv: get("voltage").and_then(integer).filter(|value| *value > 0),
        temperature_decicelsius: get("temperature").and_then(integer),
    }))
}
