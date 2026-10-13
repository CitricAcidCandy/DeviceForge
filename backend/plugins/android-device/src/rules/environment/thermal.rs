//! 只读 thermalservice 的当前 HAL 区段；缓存、热余量和 BCL 虚拟量不作温度。
use super::{Check, Error, Result, ThermalReading, clean, integer};
use std::collections::HashSet;

fn reading(line: &str) -> Option<ThermalReading> {
    let body = line
        .strip_prefix("Temperature{mValue=")?
        .strip_suffix('}')?;
    let (value, body) = body.split_once(", mType=")?;
    let (sensor_type, body) = body.split_once(", mName=")?;
    let (name, status) = body.rsplit_once(", mStatus=")?;
    let value_celsius = value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())?;
    let sensor_type = i32::try_from(integer(sensor_type)?).ok()?;
    let throttling_status = u8::try_from(integer(status)?)
        .ok()
        .filter(|value| *value <= 6)?;
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return None;
    }
    Some(ThermalReading {
        value_celsius,
        sensor_type,
        name: name.into(),
        throttling_status,
    })
}

pub(crate) fn thermal_service(output: &str, check: Check<'_>) -> Result<Vec<ThermalReading>> {
    check()?;
    if !clean(output) {
        return Ok(Vec::new());
    }
    let mut ready = None;
    let mut in_current = false;
    let mut ended = false;
    let mut readings = Vec::new();
    let mut identities = HashSet::new();
    let mut rows = 0;
    for (index, line) in output.lines().enumerate() {
        check()?;
        if index >= 1024 {
            return Err(Error::TooLarge);
        }
        let line = line.trim();
        if let Some(value) = line.strip_prefix("HAL Ready: ") {
            if ready.is_some() {
                return Ok(Vec::new());
            }
            ready = match value {
                "true" => Some(true),
                "false" => Some(false),
                _ => return Ok(Vec::new()),
            };
        }
        if line == "Current temperatures from HAL:" {
            if in_current || ended || ready != Some(true) {
                return Ok(Vec::new());
            }
            in_current = true;
            continue;
        }
        if in_current && line == "Current cooling devices from HAL:" {
            in_current = false;
            ended = true;
            continue;
        }
        if !in_current || line.is_empty() {
            continue;
        }
        rows += 1;
        if rows > 64 {
            return Err(Error::TooLarge);
        }
        let Some(reading) = reading(line) else {
            // 非有限值或单条非法记录只缺测自身，保留同区段其他合格传感器。
            continue;
        };
        // 首批只接 CPU/GPU/电池/机身，BCL 和其他类型均不猜摄氏度。
        if !(0..=3).contains(&reading.sensor_type) {
            continue;
        }
        if !identities.insert((reading.sensor_type, reading.name.clone())) {
            return Ok(Vec::new());
        }
        if readings.len() >= 32 {
            return Err(Error::TooLarge);
        }
        readings.push(reading);
    }
    check()?;
    if !ended {
        return Ok(Vec::new());
    }
    Ok(readings)
}
