//! 独立电池/HAL 文本、公开JSON与真实假ADB进程；不代表OEM或真机精度。
use crate::support::{Fixture, SERIAL, TOTAL_TIMEOUT, failure, performance, success};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UE: &str = "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=4000000\nPOWER_SUPPLY_CURRENT_NOW=-500000\nPOWER_SUPPLY_TEMP=305\n";
const BATTERY: &str = "Current Battery Service state:\n AC powered: false\n USB powered: true\n Wireless powered: false\n Dock powered: false\n present: true\n status: 3\n voltage: 4200\n temperature: 317\n Max charging current: 5000000\n";

fn thermal(rows: &str) -> String {
    format!(
        "Cached temperatures:\n Temperature{{mValue=999.0, mType=0, mName=cached, mStatus=6}}\nHAL Ready: true\nCurrent temperatures from HAL:\n{rows}Current cooling devices from HAL:\nTemperature static thresholds from HAL:\n"
    )
}

fn outputs(ue: &str, battery: &str, thermal: &str) -> [Vec<u8>; 9] {
    let mut values = performance::outputs();
    values[4] = ue.as_bytes().to_vec();
    values[5] = battery.as_bytes().to_vec();
    values[6] = thermal.as_bytes().to_vec();
    values
}

fn sample(ue: &str, battery: &str, thermal: &str) -> Value {
    let fixture = Fixture::new("environment-public-observation");
    performance::plan(&fixture, &outputs(ue, battery, thermal));
    performance::complete(&fixture, performance::request(&fixture), 9)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

#[test]
fn device_observation_preserves_serial_signed_units_sources_host_time_and_hal_types() {
    let before = now();
    let thermal = thermal(
        " Temperature{mValue=45.125, mType=0, mName=gpu-looking-name, mStatus=2}\n Temperature{mValue=43.75, mType=1, mName=gpu, mStatus=1}\n Temperature{mValue=36.125, mType=3, mName=skin, mStatus=0}\n Temperature{mValue=NaN, mType=0, mName=missing-cpu, mStatus=0}\n Temperature{mValue=4000.0, mType=6, mName=bcl-voltage, mStatus=0}\n",
    );
    let reply = sample(UE, BATTERY, &thermal);
    let result = success(&reply);
    let observation = &result["device_observation"];
    assert_eq!(observation["api_version"], 1);
    assert_eq!(observation["scope"], "device");
    assert_eq!(observation["device_id"], SERIAL);
    let battery = &observation["battery"];
    assert_eq!(battery["source"], "battery_sysfs_uevent");
    assert_eq!(battery["access"], "adb_shell");
    assert_eq!(battery["voltage_uv"], 4_000_000);
    assert_eq!(battery["current_ua"], -500_000);
    assert_eq!(battery["current_polarity"], "positive_charging");
    assert_eq!(battery["status"], "discharging");
    assert_eq!(battery["supply_state"], "external");
    assert!(battery.get("net_power_mw").is_none());
    let temperatures = observation["temperatures"].as_array().unwrap();
    assert_eq!(temperatures.len(), 4);
    assert_eq!(temperatures[0]["sensor_kind"], "cpu");
    assert_eq!(temperatures[0]["sensor_name"], "gpu-looking-name");
    assert_eq!(temperatures[0]["sensor_type"], 0);
    assert_eq!(temperatures[0]["temperature_celsius"], json!(45.125));
    assert_eq!(temperatures[0]["status"], 2);
    assert_eq!(temperatures[1]["sensor_kind"], "gpu");
    assert_eq!(temperatures[2]["sensor_kind"], "skin");
    assert_eq!(temperatures[3]["source"], "battery_sysfs_uevent");
    assert_eq!(temperatures[3]["temperature_celsius"], json!(30.5));
    assert!(temperatures[3].get("sensor_type").is_none());
    let captured = result["captured_at"].as_u64().unwrap();
    assert!(captured <= now());
    for reading in temperatures.iter().chain(std::iter::once(battery)) {
        assert!((before..=captured).contains(&reading["observed_at"].as_u64().unwrap()));
    }
}

#[test]
fn charging_polarity_and_conflicting_status_keep_current_without_absolute_value() {
    for (ue, current, polarity) in [
        (
            UE.replace("Discharging", "Charging")
                .replace("-500000", "500000"),
            500_000,
            "positive_charging",
        ),
        (UE.replace("Discharging", "Charging"), -500_000, "unknown"),
        (UE.replace("-500000", "500000"), 500_000, "unknown"),
    ] {
        let reply = sample(&ue, BATTERY, "");
        let battery = &success(&reply)["device_observation"]["battery"];
        assert_eq!(battery["current_ua"], current);
        assert_eq!(battery["current_polarity"], polarity);
    }
    let ue = UE.replace("POWER_SUPPLY_CURRENT_NOW=-500000\n", "");
    let reply = sample(&ue, BATTERY, "");
    let battery = &success(&reply)["device_observation"]["battery"];
    assert!(battery.get("current_ua").is_none());
    assert_eq!(battery["current_polarity"], "unknown");
}

#[test]
fn dumpsys_fallback_converts_mv_without_importing_current_or_max_charging_current() {
    for ue in [
        UE.replace("POWER_SUPPLY_TYPE=Battery\n", ""),
        UE.replace("POWER_SUPPLY_TYPE=Battery", "POWER_SUPPLY_TYPE=USB"),
        UE.replace(
            "POWER_SUPPLY_VOLTAGE_NOW=4000000",
            "POWER_SUPPLY_VOLTAGE_NOW=0",
        ),
        "Permission Denied".to_owned(),
    ] {
        let reply = sample(&ue, BATTERY, "");
        let observation = &success(&reply)["device_observation"];
        let battery = &observation["battery"];
        assert_eq!(battery["source"], "battery_dumpsys");
        assert_eq!(battery["voltage_uv"], 4_200_000);
        assert!(battery.get("current_ua").is_none());
        assert_eq!(battery["current_polarity"], "unknown");
        assert_eq!(battery["supply_state"], "external");
        // TYPE 不合格时电池温度也必须来自同一合法备用来源。
        if !ue.contains("POWER_SUPPLY_TYPE=Battery") {
            assert_eq!(observation["temperatures"][0]["source"], "battery_dumpsys");
            assert_eq!(
                observation["temperatures"][0]["temperature_celsius"],
                json!(31.7)
            );
        }
    }
    let fixture = Fixture::new("environment-nonzero-optional");
    performance::plan(&fixture, &outputs(UE, BATTERY, ""));
    fixture.plan(5, b"", b"private device diagnostic", 7);
    let reply = performance::complete(&fixture, performance::request(&fixture), 9);
    assert_eq!(
        success(&reply)["device_observation"]["battery"]["source"],
        "battery_dumpsys"
    );
}

#[test]
fn frozen_battery_cache_only_nan_and_empty_interfaces_do_not_invent_observation() {
    let frozen = format!("{BATTERY} (UPDATES STOPPED -- use 'reset' to restart)\n");
    for (battery, thermal) in [
        ("".to_owned(), "".to_owned()),
        (frozen, "".to_owned()),
        (
            "".to_owned(),
            "Cached temperatures:\n Temperature{mValue=99.0, mType=0, mName=cached, mStatus=6}\n"
                .to_owned(),
        ),
        (
            "".to_owned(),
            thermal("Temperature{mValue=NaN, mType=0, mName=missing, mStatus=0}\n"),
        ),
    ] {
        let reply = sample("", &battery, &thermal);
        let result = success(&reply);
        assert!(result.get("device_observation").is_none());
        assert_eq!(result["pid"], 123);
        assert_eq!(result["process_ticks"], 30);
    }
    let reply = sample(UE, &format!("{BATTERY} (UPDATES STOPPED)\n"), "");
    assert_eq!(
        success(&reply)["device_observation"]["battery"]["supply_state"],
        "unknown"
    );
}

#[test]
fn hal_battery_suppresses_only_fallback_and_sensor_bound_fails_before_identity_tool() {
    let reply = sample(
        UE,
        BATTERY,
        &thermal("Temperature{mValue=32.25, mType=2, mName=battery-hal, mStatus=0}\n"),
    );
    let temperatures = success(&reply)["device_observation"]["temperatures"]
        .as_array()
        .unwrap();
    assert_eq!(temperatures.len(), 1);
    assert_eq!(temperatures[0]["source"], "thermal_hal_current");
    assert_eq!(temperatures[0]["temperature_celsius"], json!(32.25));
    let rows = (0..32)
        .map(|index| format!("Temperature{{mValue=40.0, mType=0, mName=cpu-{index}, mStatus=0}}\n"))
        .collect::<String>();
    let fixture = Fixture::new("environment-total-sensor-limit");
    performance::plan(&fixture, &outputs(UE, BATTERY, &thermal(&rows)));
    // 32个HAL传感器加电池备用温度，合计超过公开32项上限。
    failure(
        &performance::complete(&fixture, performance::request(&fixture), 7),
        "数据超过插件限额",
    );
}

#[test]
fn each_environment_tool_output_limit_is_fatal_and_does_not_start_later_commands() {
    for stage in 5..=7 {
        for stderr in [false, true] {
            let fixture = Fixture::new("environment-output-limit");
            performance::plan(&fixture, &outputs(UE, BATTERY, ""));
            let bytes = vec![b'x'; 1024 * 1024 + 1];
            fixture.plan(
                stage,
                if stderr { b"" } else { &bytes },
                if stderr { &bytes } else { b"" },
                0,
            );
            failure(
                &performance::complete(&fixture, performance::request(&fixture), stage),
                "数据超过插件限额",
            );
        }
    }
}

#[test]
fn environment_later_tool_keeps_original_deadline_and_reaps_direct_process() {
    let fixture = Fixture::new("environment-original-deadline");
    performance::plan(&fixture, &outputs(UE, BATTERY, ""));
    let mut running = fixture.begin_request(performance::request(&fixture));
    running.start(Duration::from_secs(5));
    for index in 1..=6 {
        performance::release(&fixture, index);
    }
    let probe = fixture.wait_tool(7);
    failure(&running.complete(), TOTAL_TIMEOUT);
    probe.assert_exited();
    fixture.assert_calls(7);
}

#[test]
fn process_generation_changed_during_environment_rejects_entire_sample() {
    let fixture = Fixture::new("environment-process-restarted");
    performance::plan(&fixture, &outputs(UE, BATTERY, ""));
    fixture.plan(8, &performance::stat(123, 22, 901), b"", 0);
    failure(
        &performance::complete(&fixture, performance::request(&fixture), 8),
        "工具依赖失败：采样期间应用进程已重启",
    );
}
