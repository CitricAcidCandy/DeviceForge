use super::*;
fn battery() -> BatteryElectricalObservation {
    BatteryElectricalObservation {
        observed_at: 1000,
        source: "linux_power_supply.battery".into(),
        access: ObservationAccess::AdbShell,
        voltage_uv: 4_000_000,
        current_ua: Some(-500_000),
        current_polarity: CurrentPolarity::PositiveCharging,
        status: Some(BatteryStatus::Discharging),
        supply_state: BatterySupplyState::Battery,
    }
}
fn temperature() -> DeviceTemperature {
    DeviceTemperature {
        observed_at: 1000,
        source: "android_thermal_service".into(),
        access: ObservationAccess::AdbShell,
        sensor_kind: TemperatureKind::Cpu,
        sensor_name: "cpu-0".into(),
        sensor_type: Some(0),
        temperature_celsius: 42.25,
        status: Some(1),
    }
}
fn observation() -> DeviceObservation {
    DeviceObservation {
        api_version: 1,
        scope: ObservationScope::Device,
        device_id: "设备 一号:@%".into(),
        battery: Some(battery()),
        temperatures: vec![temperature()],
    }
}
#[test]
fn signed_net_power_keeps_units_polarity_and_real_zero() {
    let mut value = battery();
    assert_eq!(value.net_power_mw(), Some(-2000.0));
    value.current_ua = Some(500_000);
    value.current_polarity = CurrentPolarity::PositiveDischarging;
    assert_eq!(value.net_power_mw(), Some(-2000.0));
    value.current_ua = Some(0);
    assert_eq!(value.net_power_mw(), Some(0.0));
    value.current_polarity = CurrentPolarity::Unknown;
    assert_eq!(value.net_power_mw(), None);
    value.current_ua = None;
    assert_eq!(value.net_power_mw(), None);
}
#[test]
fn current_status_and_supply_qualification_are_not_inferred_or_repaired() {
    let mut value = observation();
    assert!(value.validate(1000).is_ok());
    let item = value.battery.as_mut().unwrap();
    item.current_ua = Some(500_000);
    assert!(value.validate(1000).is_err());
    value.battery.as_mut().unwrap().current_polarity = CurrentPolarity::Unknown;
    assert!(value.validate(1000).is_ok());
    value.battery.as_mut().unwrap().current_ua = None;
    assert!(value.validate(1000).is_ok());
    value.battery.as_mut().unwrap().current_polarity = CurrentPolarity::PositiveCharging;
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    let item = value.battery.as_mut().unwrap();
    item.supply_state = BatterySupplyState::External;
    item.status = Some(BatteryStatus::Charging);
    assert!(value.validate(1000).is_err());
    let item = value.battery.as_mut().unwrap();
    item.current_ua = Some(500_000);
    assert!(value.validate(1000).is_ok());
}

#[test]
fn version_identity_clock_units_and_empty_observations_are_bounded() {
    let mut value = observation();
    value.api_version = 2;
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.device_id = "\n".into();
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.battery.as_mut().unwrap().observed_at = 1001;
    assert!(value.validate(1000).is_err());
    let value = observation();
    assert!(value.validate(11000).is_ok());
    assert!(value.validate(11001).is_err());
    let mut value = observation();
    value.battery.as_mut().unwrap().voltage_uv = 50_000_001;
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.battery.as_mut().unwrap().current_ua = Some(i64::MIN);
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.battery = None;
    value.temperatures.clear();
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.battery.as_mut().unwrap().source = "server/path".into();
    assert!(value.validate(1000).is_err());
}
#[test]
fn thermal_measurements_exclude_non_temperature_bcl_and_bad_sensor_identity() {
    for sensor_type in [6, 7, 8, -1, 65] {
        let mut value = observation();
        value.temperatures[0].sensor_type = Some(sensor_type);
        assert!(value.validate(1000).is_err());
    }
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -273.16, 400.1] {
        let mut value = observation();
        value.temperatures[0].temperature_celsius = invalid;
        assert!(value.validate(1000).is_err());
    }
    let mut value = observation();
    value.temperatures[0].temperature_celsius = -1.0;
    assert!(value.validate(1000).is_ok());
    value.temperatures[0].sensor_kind = TemperatureKind::Gpu;
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.temperatures.push(value.temperatures[0].clone());
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.temperatures[0].status = Some(7);
    assert!(value.validate(1000).is_err());
    let mut value = observation();
    value.temperatures[0].sensor_name = "温度传感器".into();
    assert!(value.validate(1000).is_ok());
    value.temperatures[0].sensor_name = "\r".into();
    assert!(value.validate(1000).is_err());
}
#[test]
fn old_sample_json_remains_missing_and_new_observation_roundtrips_exactly() {
    let old = serde_json::json!({"captured_at":1000,"pid":1,"process_start_ticks":2,"process_ticks":3,"system_ticks":4,"logical_cpus":1,"pss_kib":5,"rss_kib":null});
    let sample: Sample = serde_json::from_value(old).unwrap();
    assert!(sample.device_observation.is_none());
    let mut encoded = serde_json::to_value(sample).unwrap();
    assert!(encoded.get("device_observation").is_none());
    encoded["device_observation"] = serde_json::to_value(observation()).unwrap();
    let sample: Sample = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(sample.device_observation, Some(observation()));
    assert_eq!(serde_json::to_value(sample).unwrap(), encoded);
    encoded["device_observation"]["unexpected"] = serde_json::json!(1);
    assert!(serde_json::from_value::<Sample>(encoded).is_err());
}

type Sample = crate::performance::RawPerformance;
