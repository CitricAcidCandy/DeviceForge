//! 保留各接口原始单位与宿主观测时点；功率由领域统一派生。
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BatteryState {
    Unknown,
    Charging,
    Discharging,
    NotCharging,
    Full,
}

#[derive(Debug)]
pub(crate) struct UeventBattery {
    /// 完整有界字段，用于区分缺失、原始坏值和成功解析；不作为日志输出。
    pub(crate) fields: BTreeMap<String, String>,
    pub(crate) present: Option<bool>,
    pub(crate) state: Option<BatteryState>,
    pub(crate) voltage_uv: Option<i64>,
    /// 同批 TYPE=Battery 的 Linux ABI：µA 正充电、负放电，仍需冲突核对。
    pub(crate) current_raw_ua: Option<i64>,
    pub(crate) temperature_decicelsius: Option<i64>,
}

#[derive(Debug)]
pub(crate) struct BatteryService {
    pub(crate) present: Option<bool>,
    pub(crate) state: Option<BatteryState>,
    pub(crate) external_powered: Option<bool>,
    pub(crate) voltage_mv: Option<i64>,
    pub(crate) temperature_decicelsius: Option<i64>,
}

#[derive(Debug)]
pub(crate) struct ThermalReading {
    /// HAL 报告值，不保证厂商标定值等同于物理温度。
    pub(crate) value_celsius: f64,
    pub(crate) sensor_type: i32,
    pub(crate) name: String,
    pub(crate) throttling_status: u8,
}

#[derive(Debug)]
pub(crate) struct Observed<T> {
    pub(crate) observed_at: u64,
    pub(crate) value: T,
}

/// 本批原始读取使用的已确认访问通道，不执行权限探测。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ReadAccess {
    #[default]
    AdbShell,
    RootShell,
}

#[derive(Debug, Default)]
pub(crate) struct EnvironmentObservation {
    pub(crate) access: ReadAccess,
    pub(crate) sysfs_battery: Option<Observed<UeventBattery>>,
    pub(crate) battery_service: Option<Observed<BatteryService>>,
    pub(crate) temperatures: Vec<Observed<ThermalReading>>,
}
