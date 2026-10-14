//! 明确部分缺测、旧 JSON 与 CPU 基线在真实 SQLite 中的回归。
use super::session;
use crate::performance::store::SqlitePerformance;
use apk_domain::performance::*;
use serde_json::{Value, json};

fn healthy_json(captured_at: u64, process_ticks: u64, system_ticks: u64) -> Value {
    json!({
        "captured_at": captured_at, "pid": 123, "process_start_ticks": 900,
        "process_ticks": process_ticks, "system_ticks": system_ticks,
        "logical_cpus": 2, "pss_kib": 2048, "rss_kib": 4096
    })
}
fn raw(value: Value) -> RawPerformance {
    serde_json::from_value(value).unwrap()
}
fn missing(source: &str) -> Value {
    json!({"source": source, "access": "adb_shell", "reason": "permission_denied"})
}
fn with_other_metrics(mut value: Value) -> Value {
    value["frame_window"] = json!({
        "frames": 6, "duration_ms": 100, "source": "sf_present_0011223344556677"
    });
    value["device_observation"] = json!({
        "api_version": 1, "scope": "device", "device_id": "device",
        "battery": {
            "observed_at": value["captured_at"], "source": "linux_power_supply.battery",
            "access": "adb_shell", "voltage_uv": 4000000, "current_ua": -500000,
            "current_polarity": "positive_charging", "status": "discharging",
            "supply_state": "battery"
        },
        "temperatures": [{
            "observed_at": value["captured_at"], "source": "android_thermal_service",
            "access": "adb_shell", "sensor_kind": "gpu", "sensor_name": "gpu-0",
            "sensor_type": 1, "temperature_celsius": 47.25, "status": 2
        }]
    });
    value
}
fn assert_other_metrics(reading: &PerformanceReading, expected: &Value) {
    assert_eq!(reading.fps, Some(60.0));
    assert_eq!(reading.battery_net_power_mw, Some(-2000.0));
    let stored = serde_json::to_value(reading).unwrap();
    assert_eq!(stored["frame_window"], expected["frame_window"]);
    assert_eq!(stored["device_observation"], expected["device_observation"]);
}

#[test]
fn manual_old_json_reads_after_reopen_and_keeps_numeric_cpu_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("partial-legacy.db");
    let id = uuid::Uuid::new_v4().to_string();
    let store = SqlitePerformance::open(&path).unwrap();
    store.create(session(id.clone())).unwrap();
    assert!(
        store
            .append(&id, 0, raw(healthy_json(1000, 100, 1000)))
            .unwrap()
    );
    drop(store);
    // 只在临时测试库中植入独立手写的旧版本 JSON，不由当前序列化器生成旧形状。
    let old_reading = json!({
        "sequence": 1, "captured_at": 1000, "pid": 123, "logical_cpus": 2,
        "cpu_share_percent": null, "cpu_core_percent": null,
        "pss_kib": 2048, "rss_kib": 4096
    });
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE performance_readings SET body=?2 WHERE session_id=?1 AND sequence=1",
            rusqlite::params![id, old_reading.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE performance_sessions SET last_raw=?2 WHERE id=?1",
            rusqlite::params![id, healthy_json(1000, 100, 1000).to_string()],
        )
        .unwrap();
    drop(connection);
    let store = SqlitePerformance::open(&path).unwrap();
    let old = store.samples(&id, 0, 100).unwrap();
    assert_eq!(old.readings.len(), 1);
    assert_eq!(serde_json::to_value(&old.readings[0]).unwrap(), old_reading);
    assert!(
        store
            .append(&id, 0, raw(healthy_json(2000, 110, 1100)))
            .unwrap()
    );
    let next = store.samples(&id, 1, 100).unwrap();
    assert_eq!(next.readings[0].cpu_share_percent, Some(10.0));
    assert_eq!(next.readings[0].cpu_core_percent, Some(20.0));
}

#[test]
fn cpu_missing_breaks_baseline_across_reopen_then_restores_on_next_valid_sample() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("partial-cpu.db");
    let id = uuid::Uuid::new_v4().to_string();
    let store = SqlitePerformance::open(&path).unwrap();
    store.create(session(id.clone())).unwrap();
    let first = with_other_metrics(healthy_json(1000, 100, 1000));
    let mut gap = with_other_metrics(healthy_json(2000, 110, 1100));
    gap["system_ticks"] = Value::Null;
    gap["logical_cpus"] = Value::Null;
    gap["metric_missing"] = json!({"api_version": 1, "cpu": missing("linux_proc.stat")});
    assert!(store.append(&id, 0, raw(first.clone())).unwrap());
    assert!(store.append(&id, 0, raw(gap.clone())).unwrap());
    drop(store);
    let store = SqlitePerformance::open(&path).unwrap();
    let restored = with_other_metrics(healthy_json(3000, 120, 1200));
    let following = with_other_metrics(healthy_json(4000, 130, 1300));
    assert!(store.append(&id, 0, raw(restored.clone())).unwrap());
    assert!(store.append(&id, 0, raw(following.clone())).unwrap());
    drop(store);
    let store = SqlitePerformance::open(&path).unwrap();
    let page = store.samples(&id, 0, 100).unwrap();
    assert_eq!(page.session.samples, 4);
    assert_eq!(page.readings.len(), 4);
    for (reading, expected) in page.readings.iter().zip([first, gap, restored, following]) {
        assert_other_metrics(reading, &expected);
        assert_eq!(reading.pss_kib, Some(2048));
        assert_eq!(reading.rss_kib, Some(4096));
    }
    for reading in &page.readings[..3] {
        assert!(reading.cpu_share_percent.is_none());
        assert!(reading.cpu_core_percent.is_none());
    }
    assert_eq!(page.readings[1].logical_cpus, None);
    let missing_reading = serde_json::to_value(&page.readings[1]).unwrap();
    assert_eq!(
        missing_reading["metric_missing"]["cpu"],
        missing("linux_proc.stat")
    );
    assert!(missing_reading["metric_missing"]["memory"].is_null());
    assert_eq!(page.readings[3].cpu_share_percent, Some(10.0));
    assert_eq!(page.readings[3].cpu_core_percent, Some(20.0));
    assert!(page.readings[2].metric_missing.is_none());
    assert!(page.readings[3].metric_missing.is_none());
}

#[test]
fn memory_permission_reason_and_other_raw_metrics_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("partial-memory.db");
    let id = uuid::Uuid::new_v4().to_string();
    let store = SqlitePerformance::open(&path).unwrap();
    store.create(session(id.clone())).unwrap();
    let mut value = with_other_metrics(healthy_json(1000, 100, 1000));
    value["pss_kib"] = Value::Null;
    value["rss_kib"] = Value::Null;
    value["metric_missing"] =
        json!({"api_version": 1, "memory": missing("android_dumpsys.meminfo")});
    assert!(store.append(&id, 0, raw(value.clone())).unwrap());
    drop(store);
    let store = SqlitePerformance::open(&path).unwrap();
    let page = store.samples(&id, 0, 100).unwrap();
    assert_eq!(page.session.samples, 1);
    assert_eq!(page.readings.len(), 1);
    let reading = &page.readings[0];
    assert_eq!(reading.logical_cpus, Some(2));
    assert_eq!(reading.pss_kib, None);
    assert_eq!(reading.rss_kib, None);
    assert_other_metrics(reading, &value);
    let stored = serde_json::to_value(reading).unwrap();
    assert_eq!(
        stored["metric_missing"]["memory"],
        missing("android_dumpsys.meminfo")
    );
    assert!(stored["metric_missing"]["cpu"].is_null());
}
