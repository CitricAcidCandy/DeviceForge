//! 主进程 CPU、展示 FPS 与整机净电池功率的纯派生规则，不访问设备或宿主领域。
use apk_plugin_sdk::{CurrentPolarity, PerformanceSample};
use serde::Serialize;

const CPU_FIRST: &str = "首个采样缺少相邻 CPU 计数";
const CPU_IDENTITY: &str = "相邻采样的主进程身份、时间或逻辑核数无法连续确认";
const CPU_COUNTERS: &str = "相邻 CPU 计数回退、系统跨度为零或进程计数超过系统";
const FPS_MISSING: &str = "未取得主进程展示帧窗口";
const FPS_INVALID: &str = "主进程展示帧窗口的单位或范围无效";
const BATTERY_MISSING: &str = "未取得设备电池观测";
const BATTERY_INVALID: &str = "设备电池观测未通过公开契约资格";
const BATTERY_POLARITY: &str = "电池电流极性未知，无法计算净功率";
const BATTERY_CURRENT: &str = "未取得电池电流，无法计算净功率";

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Derived {
    pub api_version: u32,
    pub cpu_share_percent: Option<f64>,
    pub cpu_core_percent: Option<f64>,
    pub cpu_reason: Option<&'static str>,
    pub fps: Option<f64>,
    pub fps_reason: Option<&'static str>,
    pub battery_net_power_mw: Option<f64>,
    pub battery_reason: Option<&'static str>,
}

pub(super) fn from_sample(
    current: &PerformanceSample,
    previous: Option<&PerformanceSample>,
) -> Derived {
    let (cpu_share_percent, cpu_core_percent, cpu_reason) = match cpu(current, previous) {
        Ok((share, core)) => (Some(share), Some(core), None),
        Err(reason) => (None, None, Some(reason)),
    };
    let (fps, fps_reason) = measured(fps(current));
    let (battery_net_power_mw, battery_reason) = measured(battery(current));
    Derived {
        api_version: 1,
        cpu_share_percent,
        cpu_core_percent,
        cpu_reason,
        fps,
        fps_reason,
        battery_net_power_mw,
        battery_reason,
    }
}

fn measured(value: std::result::Result<f64, &'static str>) -> (Option<f64>, Option<&'static str>) {
    match value {
        Ok(value) => (Some(value), None),
        Err(reason) => (None, Some(reason)),
    }
}

fn cpu(
    current: &PerformanceSample,
    previous: Option<&PerformanceSample>,
) -> std::result::Result<(f64, f64), &'static str> {
    let previous = previous.ok_or(CPU_FIRST)?;
    if current.pid != previous.pid
        || current.process_start_ticks != previous.process_start_ticks
        || current.captured_at <= previous.captured_at
        || current.logical_cpus == 0
        || current.logical_cpus != previous.logical_cpus
    {
        return Err(CPU_IDENTITY);
    }
    // 先以整数取得真实增量，再转换比率，避免大累计计数先转浮点后损失差值。
    let process = current
        .process_ticks
        .checked_sub(previous.process_ticks)
        .ok_or(CPU_COUNTERS)?;
    let system = current
        .system_ticks
        .checked_sub(previous.system_ticks)
        .filter(|delta| *delta > 0)
        .ok_or(CPU_COUNTERS)?;
    if process > system {
        return Err(CPU_COUNTERS);
    }
    let share = process as f64 / system as f64 * 100.0;
    Ok((share, share * f64::from(current.logical_cpus)))
}

fn fps(current: &PerformanceSample) -> std::result::Result<f64, &'static str> {
    let window = current.frame_window.as_ref().ok_or(FPS_MISSING)?;
    if !(1..=60_000).contains(&window.duration_ms)
        || window.frames > u64::from(window.duration_ms)
        || window.source.is_empty()
        || window.source.len() > 80
        || !window
            .source
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(FPS_INVALID);
    }
    Ok(window.frames as f64 * 1000.0 / f64::from(window.duration_ms))
}

fn battery(current: &PerformanceSample) -> std::result::Result<f64, &'static str> {
    let observation = current.device_observation.as_ref().ok_or(BATTERY_MISSING)?;
    let battery = observation.battery.as_ref().ok_or(BATTERY_MISSING)?;
    observation
        .validate(current.captured_at)
        .map_err(|_| BATTERY_INVALID)?;
    if battery.current_ua.is_none() {
        return Err(BATTERY_CURRENT);
    }
    if battery.current_polarity == CurrentPolarity::Unknown {
        return Err(BATTERY_POLARITY);
    }
    // SDK 明确统一正负方向：充电为正、放电为负；未知极性绝不由供电状态反推。
    battery
        .net_power_mw()
        .filter(|power| power.is_finite())
        .ok_or(BATTERY_INVALID)
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_plugin_sdk::{
        BatteryElectricalObservation, BatteryStatus, BatterySupplyState, DeviceObservation,
        FrameWindow, ObservationAccess, ObservationScope,
    };

    fn sample() -> PerformanceSample {
        PerformanceSample {
            captured_at: 1000,
            pid: 123,
            process_start_ticks: 900,
            process_ticks: 100,
            system_ticks: 1000,
            logical_cpus: 8,
            pss_kib: 2048,
            rss_kib: None,
            frame_window: None,
            device_observation: None,
        }
    }
    fn next() -> PerformanceSample {
        PerformanceSample {
            captured_at: 2000,
            process_ticks: 110,
            system_ticks: 1100,
            ..sample()
        }
    }
    fn observed_battery() -> DeviceObservation {
        DeviceObservation {
            api_version: 1,
            scope: ObservationScope::Device,
            device_id: "test-device".into(),
            battery: Some(BatteryElectricalObservation {
                observed_at: 1000,
                source: "linux_power_supply.battery".into(),
                access: ObservationAccess::AdbShell,
                voltage_uv: 4_000_000,
                current_ua: Some(-500_000),
                current_polarity: CurrentPolarity::PositiveCharging,
                status: Some(BatteryStatus::Discharging),
                supply_state: BatterySupplyState::Battery,
            }),
            temperatures: Vec::new(),
        }
    }
    #[test]
    fn first_sample_is_missing_with_fixed_reasons_and_explicit_json_nulls() {
        let value = from_sample(&sample(), None);
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            serde_json::json!({
            "api_version": 1, "cpu_share_percent": null, "cpu_core_percent": null,
            "cpu_reason": CPU_FIRST, "fps": null, "fps_reason": FPS_MISSING,
            "battery_net_power_mw": null, "battery_reason": BATTERY_MISSING })
        );
    }
    #[test]
    fn cpu_share_and_core_usage_use_adjacent_integer_deltas_and_keep_real_zero() {
        let value = from_sample(&next(), Some(&sample()));
        assert_eq!(value.cpu_share_percent, Some(10.0));
        assert_eq!(value.cpu_core_percent, Some(80.0));
        assert_eq!(value.cpu_reason, None);
        let mut current = next();
        current.process_ticks = sample().process_ticks;
        let value = from_sample(&current, Some(&sample()));
        assert_eq!(value.cpu_share_percent, Some(0.0));
        assert_eq!(value.cpu_core_percent, Some(0.0));
        assert_eq!(value.cpu_reason, None);
        let mut previous = sample();
        previous.process_ticks = u64::MAX - 200;
        previous.system_ticks = u64::MAX - 200;
        current.process_ticks = u64::MAX - 199;
        current.system_ticks = u64::MAX - 100;
        let value = from_sample(&current, Some(&previous));
        assert_eq!(value.cpu_share_percent, Some(1.0));
        assert_eq!(value.cpu_core_percent, Some(8.0));
    }
    #[test]
    fn cpu_identity_time_core_count_and_invalid_counter_transitions_are_missing() {
        let mut invalid = Vec::new();
        let mut value = next();
        value.pid += 1;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.process_start_ticks += 1;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.captured_at = 1000;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.captured_at = 999;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.logical_cpus = 4;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.logical_cpus = 0;
        invalid.push((value, CPU_IDENTITY));
        let mut value = next();
        value.process_ticks = 99;
        invalid.push((value, CPU_COUNTERS));
        let mut value = next();
        value.system_ticks = 999;
        invalid.push((value, CPU_COUNTERS));
        let mut value = next();
        value.system_ticks = 1000;
        invalid.push((value, CPU_COUNTERS));
        let mut value = next();
        value.process_ticks = 201;
        invalid.push((value, CPU_COUNTERS));
        for (value, reason) in invalid {
            let derived = from_sample(&value, Some(&sample()));
            assert_eq!(derived.cpu_share_percent, None);
            assert_eq!(derived.cpu_core_percent, None);
            assert_eq!(derived.cpu_reason, Some(reason));
        }
    }

    #[test]
    fn fps_uses_only_a_qualified_present_window_and_preserves_real_zero() {
        let mut value = sample();
        value.frame_window = Some(FrameWindow {
            frames: 3,
            duration_ms: 50,
            source: "sf_present_fixture".into(),
        });
        let derived = from_sample(&value, None);
        assert_eq!(derived.fps, Some(60.0));
        assert_eq!(derived.fps_reason, None);
        value.frame_window.as_mut().unwrap().frames = 0;
        assert_eq!(from_sample(&value, None).fps, Some(0.0));
        assert_eq!(from_sample(&value, None).fps_reason, None);
        for (frames, duration_ms, source) in [
            (1, 0, "sf"),
            (1, 60_001, "sf"),
            (51, 50, "sf"),
            (1, 50, ""),
            (1, 50, "invalid/source"),
        ] {
            value.frame_window = Some(FrameWindow {
                frames,
                duration_ms,
                source: source.into(),
            });
            let derived = from_sample(&value, None);
            assert_eq!(derived.fps, None);
            assert_eq!(derived.fps_reason, Some(FPS_INVALID));
        }
    }
    #[test]
    fn known_battery_polarities_use_sdk_signed_net_power_and_preserve_real_zero() {
        let mut value = sample();
        value.device_observation = Some(observed_battery());
        let derived = from_sample(&value, None);
        assert_eq!(derived.battery_net_power_mw, Some(-2000.0));
        assert_eq!(derived.battery_reason, None);
        let battery = value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap();
        battery.current_polarity = CurrentPolarity::PositiveDischarging;
        battery.current_ua = Some(500_000);
        assert_eq!(
            from_sample(&value, None).battery_net_power_mw,
            Some(-2000.0)
        );
        value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap()
            .current_ua = Some(0);
        assert_eq!(from_sample(&value, None).battery_net_power_mw, Some(0.0));
        assert_eq!(from_sample(&value, None).battery_reason, None);
        let battery = value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap();
        battery.current_polarity = CurrentPolarity::PositiveCharging;
        battery.current_ua = Some(500_000);
        battery.status = Some(BatteryStatus::Charging);
        battery.supply_state = BatterySupplyState::External;
        assert_eq!(from_sample(&value, None).battery_net_power_mw, Some(2000.0));
    }
    #[test]
    fn unknown_current_polarity_missing_current_and_invalid_observation_never_guess_power() {
        let mut value = sample();
        value.device_observation = Some(observed_battery());
        value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap()
            .current_polarity = CurrentPolarity::Unknown;
        let derived = from_sample(&value, None);
        assert_eq!(derived.battery_net_power_mw, None);
        assert_eq!(derived.battery_reason, Some(BATTERY_POLARITY));
        value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap()
            .current_ua = None;
        assert_eq!(
            from_sample(&value, None).battery_reason,
            Some(BATTERY_CURRENT)
        );
        value.device_observation = Some(observed_battery());
        value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap()
            .current_ua = Some(500_000);
        assert_eq!(
            from_sample(&value, None).battery_reason,
            Some(BATTERY_INVALID)
        );
        value.device_observation = Some(observed_battery());
        value
            .device_observation
            .as_mut()
            .unwrap()
            .battery
            .as_mut()
            .unwrap()
            .observed_at = 1001;
        assert_eq!(
            from_sample(&value, None).battery_reason,
            Some(BATTERY_INVALID)
        );
        value.device_observation = Some(observed_battery());
        value.device_observation.as_mut().unwrap().battery = None;
        assert_eq!(
            from_sample(&value, None).battery_reason,
            Some(BATTERY_MISSING)
        );
    }
    #[test]
    fn derived_serialization_is_optional_and_original_metrics_are_unchanged() {
        let metrics = serde_json::to_value(sample()).unwrap();
        let current: PerformanceSample = serde_json::from_value(metrics.clone()).unwrap();
        let mut value = super::super::models::Sample {
            index: 0,
            begin_ns: "1".into(),
            end_ns: "2".into(),
            target_ns: "1".into(),
            metrics: metrics.clone(),
            derived: None,
            frame: None,
            stack_sample_indices: Vec::new(),
        };
        let old = serde_json::to_value(&value).unwrap();
        assert!(old.get("derived").is_none());
        value.derived = Some(from_sample(&current, None));
        let encoded = serde_json::to_value(&value).unwrap();
        assert_eq!(encoded["metrics"], metrics);
        assert_eq!(encoded["derived"]["api_version"], 1);
        assert!(encoded["derived"]["cpu_share_percent"].is_null());
    }
}
