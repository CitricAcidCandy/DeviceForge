//! 手写固定输出，分别核单位、缺失资格和厂商未知方向；不依赖真实设备。
use super::*;

fn check() -> Result<()> {
    Ok(())
}

const UEVENT: &str = "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=3800000\nPOWER_SUPPLY_CURRENT_NOW=-250000\nPOWER_SUPPLY_TEMP=315\nPOWER_SUPPLY_VENDOR_FIELD=preserve\n";
const BATTERY: &str = "Current Battery Service state:\n AC powered: false\n USB powered: false\n Wireless powered: false\n Dock powered: false\n present: true\n status: 3\n voltage: 3800\n temperature: 315\n Max charging current: 5000000\n Max charging voltage: 9000000\n";

fn thermal(rows: &str) -> String {
    format!(
        "IsStatusOverride: false\nCached temperatures:\n Temperature{{mValue=900.0, mType=0, mName=cached, mStatus=6}}\nHAL Ready: true\nHAL connection:\n ignored wrapper details\nCurrent temperatures from HAL:\n{rows}Current cooling devices from HAL:\nTemperature static thresholds from HAL:\n"
    )
}

#[test]
fn battery_uevent_preserves_full_fields_and_original_units_without_power_guess() {
    let value = battery_uevent(UEVENT, &check).unwrap().unwrap();
    assert_eq!(value.present, Some(true));
    assert_eq!(value.state, Some(BatteryState::Discharging));
    assert_eq!(value.voltage_uv, Some(3_800_000));
    assert_eq!(value.current_raw_ua, Some(-250_000));
    assert_eq!(value.temperature_decicelsius, Some(315));
    assert_eq!(
        value
            .fields
            .get("POWER_SUPPLY_VENDOR_FIELD")
            .map(String::as_str),
        Some("preserve")
    );
    let reverse = battery_uevent(&UEVENT.replace("-250000", "250000"), &check)
        .unwrap()
        .unwrap();
    assert_eq!(reverse.current_raw_ua, Some(250_000));
    assert_eq!(reverse.state, value.state);
}

#[test]
fn battery_uevent_missing_and_invalid_values_keep_qualification_in_raw_fields() {
    let value = battery_uevent(
        "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_CURRENT_NOW=bad\nPOWER_SUPPLY_TEMP=-12\n",
        &check,
    )
    .unwrap()
    .unwrap();
    assert_eq!(value.current_raw_ua, None);
    assert_eq!(value.voltage_uv, None);
    assert_eq!(value.state, None);
    assert_eq!(value.present, None);
    assert_eq!(value.temperature_decicelsius, Some(-12));
    assert_eq!(
        value
            .fields
            .get("POWER_SUPPLY_CURRENT_NOW")
            .map(String::as_str),
        Some("bad")
    );
    for input in [
        "",
        "POWER_SUPPLY_NAME=usb\n",
        "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=USB\n",
        "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_NAME=battery\n",
        "POWER_SUPPLY_NAME=battery\nnot-a-field\n",
    ] {
        assert!(battery_uevent(input, &check).unwrap().is_none());
    }
}

#[test]
fn battery_service_requires_real_updates_and_preserves_fallback_units() {
    let value = battery_service(BATTERY, &check).unwrap().unwrap();
    assert_eq!(value.present, Some(true));
    assert_eq!(value.state, Some(BatteryState::Discharging));
    assert_eq!(value.external_powered, Some(false));
    assert_eq!(value.voltage_mv, Some(3800));
    assert_eq!(value.temperature_decicelsius, Some(315));
    assert!(
        battery_service(
            &format!("{BATTERY} (UPDATES STOPPED -- use 'reset' to restart)\n"),
            &check
        )
        .unwrap()
        .is_none()
    );
    assert!(
        battery_service("voltage: 3800\ntemperature: 315\n", &check)
            .unwrap()
            .is_none()
    );
    assert!(
        battery_service(&format!("{BATTERY} voltage: 3800\n"), &check)
            .unwrap()
            .is_none()
    );
}

#[test]
fn battery_service_partial_power_never_invents_unplugged_state_or_current() {
    let partial = BATTERY.replace(" Dock powered: false\n", "");
    assert_eq!(
        battery_service(&partial, &check)
            .unwrap()
            .unwrap()
            .external_powered,
        None
    );
    let plugged = partial.replace(" USB powered: false", " USB powered: true");
    assert_eq!(
        battery_service(&plugged, &check)
            .unwrap()
            .unwrap()
            .external_powered,
        Some(true)
    );
    let maxima_only = "Current Battery Service state:\n Max charging current: 5000000\n Max charging voltage: 9000000\n";
    let value = battery_service(maxima_only, &check).unwrap().unwrap();
    assert_eq!(value.voltage_mv, None);
    assert_eq!(value.temperature_decicelsius, None);
    assert_eq!(value.external_powered, None);
}

#[test]
fn thermal_uses_current_hal_values_names_types_and_status_not_cache_or_bcl() {
    let output = thermal(
        " Temperature{mValue=46.125, mType=0, mName=cpu-0, mStatus=2}\n Temperature{mValue=31.5, mType=2, mName=battery, mStatus=0}\n Temperature{mValue=4000.0, mType=6, mName=bcl-voltage, mStatus=0}\n Temperature{mValue=25.0, mType=-1, mName=unknown, mStatus=0}\n",
    );
    let values = thermal_service(&output, &check).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].value_celsius, 46.125);
    assert_eq!(values[0].sensor_type, 0);
    assert_eq!(values[0].name, "cpu-0");
    assert_eq!(values[0].throttling_status, 2);
    assert_eq!(values[1].sensor_type, 2);
    assert_eq!(values[1].name, "battery");
}

#[test]
fn thermal_incomplete_hal_unknown_format_nonfinite_and_duplicate_are_absent() {
    let valid = thermal(" Temperature{mValue=40.0, mType=1, mName=gpu, mStatus=1}\n");
    for output in [
        "Cached temperatures:\n Temperature{mValue=90.0, mType=0, mName=cached, mStatus=6}\n"
            .to_owned(),
        valid.replace("HAL Ready: true", "HAL Ready: false"),
        valid.replace("Current cooling devices from HAL:", "unknown end:"),
        valid.replace("mValue=40.0", "mValue=NaN"),
        valid.replace("mValue=40.0", "mValue=Infinity"),
        valid.replace("mStatus=1", "mStatus=7"),
        thermal(
            " Temperature{mValue=40.0, mType=1, mName=gpu, mStatus=1}\n Temperature{mValue=41.0, mType=1, mName=gpu, mStatus=1}\n",
        ),
        valid.replace("HAL Ready: true", "HAL Ready: true\nHAL Ready: true"),
        valid.replace("mName=gpu", "mName="),
    ] {
        assert!(thermal_service(&output, &check).unwrap().is_empty());
    }
}

#[test]
fn environment_structural_limits_and_context_failures_are_not_optional_dependency() {
    let large = format!(
        "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\n{}",
        (0..128)
            .map(|index| format!("POWER_SUPPLY_FIELD_{index}=1\n"))
            .collect::<String>()
    );
    assert!(matches!(
        battery_uevent(&large, &check),
        Err(Error::TooLarge)
    ));
    let large = format!(
        "Current Battery Service state:\n{}",
        "unknown: 1\n".repeat(512)
    );
    assert!(matches!(
        battery_service(&large, &check),
        Err(Error::TooLarge)
    ));
    let rows = (0..65)
        .map(|index| {
            format!(" Temperature{{mValue=40.0, mType=0, mName=cpu-{index}, mStatus=0}}\n")
        })
        .collect::<String>();
    assert!(matches!(
        thermal_service(&thermal(&rows), &check),
        Err(Error::TooLarge)
    ));
    let cancelled = || Err(Error::Cancelled);
    assert!(matches!(
        battery_uevent(UEVENT, &cancelled),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        battery_service(BATTERY, &cancelled),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        thermal_service(&thermal(""), &cancelled),
        Err(Error::Cancelled)
    ));
}

#[test]
fn environment_rejects_lossy_bytes_and_keeps_independent_sources() {
    for output in [
        "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TEMP=30\u{fffd}\n",
        "POWER_SUPPLY_NAME=battery\0\n",
    ] {
        assert!(battery_uevent(output, &check).unwrap().is_none());
    }
    let observation = EnvironmentObservation {
        access: ReadAccess::default(),
        sysfs_battery: battery_uevent(UEVENT, &check)
            .unwrap()
            .map(|value| Observed {
                observed_at: 1000,
                value,
            }),
        battery_service: battery_service(BATTERY, &check)
            .unwrap()
            .map(|value| Observed {
                observed_at: 1001,
                value,
            }),
        temperatures: Vec::new(),
    };
    assert_eq!(
        observation.sysfs_battery.unwrap().value.voltage_uv,
        Some(3_800_000)
    );
    assert_eq!(
        observation.battery_service.unwrap().value.voltage_mv,
        Some(3800)
    );
    assert!(observation.temperatures.is_empty());
}

#[test]
fn thermal_single_invalid_row_keeps_other_current_hal_sensors() {
    let values = thermal_service(&thermal(" Temperature{mValue=NaN, mType=0, mName=bad-cpu, mStatus=0}\n Temperature{mValue=43.75, mType=1, mName=gpu-current, mStatus=1}\n Temperature{mValue=Infinity, mType=3, mName=bad-skin, mStatus=0}\n"), &check).unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].name, "gpu-current");
    assert_eq!(values[0].value_celsius, 43.75);
}

#[test]
fn battery_service_oem_backup_preserves_only_current_section() {
    let output = format!(
        "BatteryInfoBackUp\n{BATTERY} current now: 321\nBatteryInfoBackUp\n mSavedBatteryAsoc: 87\n mSavedBatteryMaxTemp: 777\n"
    );
    let value = battery_service(&output, &check).unwrap().unwrap();
    assert_eq!(value.present, Some(true));
    assert_eq!(value.state, Some(BatteryState::Discharging));
    assert_eq!(value.external_powered, Some(false));
    assert_eq!(value.voltage_mv, Some(3800));
    assert_eq!(value.temperature_decicelsius, Some(315));
}

#[test]
fn battery_service_oem_backup_never_fills_missing_current_section_voltage() {
    let partial = BATTERY.replace(" voltage: 3800\n", "");
    let output = format!("{partial}BatteryInfoBackUp\n voltage: 9999\n");
    let value = battery_service(&output, &check).unwrap().unwrap();
    assert_eq!(value.voltage_mv, None);
    assert_eq!(value.temperature_decicelsius, Some(315));
}

#[test]
fn battery_service_oem_backup_preserves_structural_rejections() {
    for output in [
        format!("{BATTERY}BatteryInfoBackUp\nBatteryInfoBackUp\n"),
        format!("{BATTERY}BatteryInfoBackUp\nCurrent Battery Service state:\n"),
        format!("{BATTERY}BatteryInfoBackUp\n voltage: 3800\n"),
        format!("{BATTERY}BatteryInfoBackUp\n present: true\n"),
        format!("{BATTERY}unexpected section\nBatteryInfoBackUp\n"),
        format!("{BATTERY}BatteryInfoBackUp\nunexpected section\n"),
        format!("{BATTERY}BatteryInfoBackup\n"),
        format!("{BATTERY}BatteryInfoBackUp\nUPDATES STOPPED\n"),
    ] {
        assert!(battery_service(&output, &check).unwrap().is_none());
    }
}

#[test]
fn battery_service_oem_backup_keeps_limits_and_context_checks() {
    let large = format!(
        "{BATTERY}BatteryInfoBackUp\n{}",
        " saved value: 1\n".repeat(512)
    );
    assert!(matches!(
        battery_service(&large, &check),
        Err(Error::TooLarge)
    ));
    let output = format!("{BATTERY}BatteryInfoBackUp\n saved value: 1\n");
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let cancelled = || {
        let count = calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if count >= BATTERY.lines().count() + 3 {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    };
    assert!(matches!(
        battery_service(&output, &cancelled),
        Err(Error::Cancelled)
    ));
}
