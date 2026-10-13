//! 设备观测与旧历史在真实 SQLite 中的兼容、保真和暂停基线。
use super::{raw, session};
use crate::performance::store::SqlitePerformance;
use apk_domain::performance::*;
fn observation() -> DeviceObservation {
    DeviceObservation {
        api_version: 1,
        scope: ObservationScope::Device,
        device_id: "device".into(),
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
        temperatures: vec![DeviceTemperature {
            observed_at: 1000,
            source: "android_thermal_service".into(),
            access: ObservationAccess::AdbShell,
            sensor_kind: TemperatureKind::Gpu,
            sensor_name: "gpu-0".into(),
            sensor_type: Some(1),
            temperature_celsius: 47.25,
            status: Some(2),
        }],
    }
}
#[test]
fn old_json_and_new_raw_units_survive_reopen_with_signed_net_power() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("observations.db");
    let id = uuid::Uuid::new_v4().to_string();
    let store = SqlitePerformance::open(&path).unwrap();
    store.create(session(id.clone())).unwrap();
    store.append(&id, 0, raw(100, 1000)).unwrap();
    let mut current = raw(110, 1100);
    current.captured_at = 1000;
    current.device_observation = Some(observation());
    store.append(&id, 0, current).unwrap();
    drop(store);
    let store = SqlitePerformance::open(&path).unwrap();
    let page = store.samples(&id, 0, 100).unwrap();
    assert_eq!(page.readings.len(), 2);
    assert!(page.readings[0].device_observation.is_none());
    assert!(page.readings[0].battery_net_power_mw.is_none());
    assert!(
        serde_json::to_value(&page.readings[0])
            .unwrap()
            .get("device_observation")
            .is_none()
    );
    assert_eq!(page.readings[1].device_observation, Some(observation()));
    assert_eq!(page.readings[1].battery_net_power_mw, Some(-2000.0));
    assert_eq!(page.readings[1].cpu_share_percent, Some(10.0));
}
#[test]
fn pause_resets_cpu_baseline_without_erasing_device_observation() {
    let store = SqlitePerformance::open(":memory:").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.create(session(id.clone())).unwrap();
    store.append(&id, 0, raw(100, 1000)).unwrap();
    let paused = store
        .transition(&id, 0, PerformanceState::Paused, None)
        .unwrap();
    let resumed = store
        .transition(&id, paused.revision, PerformanceState::Running, None)
        .unwrap();
    let mut current = raw(110, 1100);
    current.captured_at = 1000;
    current.device_observation = Some(observation());
    store.append(&id, resumed.revision, current).unwrap();
    let page = store.samples(&id, 1, 100).unwrap();
    assert!(page.readings[0].cpu_share_percent.is_none());
    assert_eq!(page.readings[0].battery_net_power_mw, Some(-2000.0));
    assert_eq!(page.readings[0].device_observation, Some(observation()));
}

#[test]
fn mismatched_device_is_rejected_without_publishing_or_advancing_sequence() {
    let store = SqlitePerformance::open(":memory:").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.create(session(id.clone())).unwrap();
    let mut current = raw(100, 1000);
    current.captured_at = 1000;
    current.device_observation = Some(observation());
    current.device_observation.as_mut().unwrap().device_id = "other-device".into();
    assert!(store.append(&id, 0, current).is_err());
    assert_eq!(store.get(&id).unwrap().samples, 0);
    assert!(store.samples(&id, 0, 100).unwrap().readings.is_empty());
}
