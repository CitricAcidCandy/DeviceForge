//! 电气与环境输出的私有纯解析；不使用 SDK，不触发设备或系统修改。
mod battery;
mod mapping;
mod model;
pub(crate) use mapping::observation;
mod thermal;
pub(crate) use battery::{battery_service, battery_uevent};
pub(crate) use model::{
    BatteryService, BatteryState, EnvironmentObservation, Observed, ThermalReading, UeventBattery,
};
pub(crate) use thermal::thermal_service;

use crate::{Error, Result, rules::performance::Check};

fn integer(value: &str) -> Option<i64> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn clean(output: &str) -> bool {
    !output.contains('\u{fffd}') && !output.contains('\0')
}

#[cfg(test)]
mod tests;
