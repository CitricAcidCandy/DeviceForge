//! 公共观测映射的数值、来源和资格回归；不使用设备工具。
use super::*;
use crate::rules::environment::{battery_service, battery_uevent, thermal_service};

const UE: &str = "POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=3800000\nPOWER_SUPPLY_CURRENT_NOW=-250000\nPOWER_SUPPLY_TEMP=315\n";
const SERVICE: &str = "Current Battery Service state:\nAC powered: false\nUSB powered: false\nWireless powered: false\nDock powered: false\npresent: true\nstatus: 3\nvoltage: 3800\ntemperature: 315\n";

fn check() -> Result<()> {
    Ok(())
}

fn raw(ue: &str, service: &str, temperatures: &str) -> EnvironmentObservation {
    EnvironmentObservation {
        access: ReadAccess::default(),
        sysfs_battery: battery_uevent(ue, &check).unwrap().map(|value| Observed {
            observed_at: 1000,
            value,
        }),
        battery_service: battery_service(service, &check)
            .unwrap()
            .map(|value| Observed {
                observed_at: 1001,
                value,
            }),
        temperatures: thermal_service(temperatures, &check)
            .unwrap()
            .into_iter()
            .map(|value| Observed {
                observed_at: 1002,
                value,
            })
            .collect(),
    }
}

fn output(ue: &str, service: &str, temperatures: &str) -> DeviceObservation {
    observation(raw(ue, service, temperatures), "设备 原文".into(), &check)
        .unwrap()
        .unwrap()
}

#[test]
fn same_battery_sysfs_keeps_signed_ua_and_voltage_uv() {
    let result = output(UE, SERVICE, "");
    assert_eq!(result.api_version, 1);
    assert_eq!(result.scope, ObservationScope::Device);
    assert_eq!(result.device_id, "设备 原文");
    let battery = result.battery.unwrap();
    assert_eq!(battery.observed_at, 1000);
    assert_eq!(battery.source, "battery_sysfs_uevent");
    assert_eq!(battery.access, ObservationAccess::AdbShell);
    assert_eq!(battery.voltage_uv, 3_800_000);
    assert_eq!(battery.current_ua, Some(-250_000));
    assert_eq!(battery.current_polarity, CurrentPolarity::PositiveCharging);
    assert_eq!(battery.status, Some(BatteryStatus::Discharging));
    assert_eq!(battery.supply_state, BatterySupplyState::Battery);
    assert_eq!(result.temperatures[0].temperature_celsius, 31.5);
    assert_eq!(result.temperatures[0].sensor_type, None);
}

#[test]
fn charging_and_external_net_discharging_keep_signed_current_without_abs() {
    let plugged = SERVICE.replace("USB powered: false", "USB powered: true");
    let charging = UE
        .replace("Discharging", "Charging")
        .replace("-250000", "250000");
    let battery = output(&charging, &plugged, "").battery.unwrap();
    assert_eq!(battery.current_ua, Some(250_000));
    assert_eq!(battery.current_polarity, CurrentPolarity::PositiveCharging);
    assert_eq!(battery.supply_state, BatterySupplyState::External);
    let battery = output(UE, &plugged, "").battery.unwrap();
    assert_eq!(battery.current_ua, Some(-250_000));
    assert_eq!(battery.current_polarity, CurrentPolarity::PositiveCharging);
}

#[test]
fn inconsistent_state_or_battery_supply_downgrades_polarity_and_preserves_raw() {
    for ue in [
        UE.replace("Discharging", "Charging"),
        UE.replace("-250000", "250000"),
        UE.replace("Discharging", "Full"),
        UE.replace("Discharging", "Unknown")
            .replace("-250000", "250000"),
    ] {
        let battery = output(&ue, SERVICE, "").battery.unwrap();
        assert!(battery.current_ua.is_some());
        assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
    }
    let missing = UE.replace("POWER_SUPPLY_CURRENT_NOW=-250000\n", "");
    let battery = output(&missing, SERVICE, "").battery.unwrap();
    assert_eq!(battery.current_ua, None);
    assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
}

#[test]
fn missing_type_or_voltage_uses_dumpsys_without_cross_source_current() {
    for ue in [
        UE.replace("POWER_SUPPLY_TYPE=Battery\n", ""),
        UE.replace("3800000", "0"),
    ] {
        let result = output(&ue, SERVICE, "");
        let battery = result.battery.unwrap();
        assert_eq!(battery.source, "battery_dumpsys");
        assert_eq!(battery.observed_at, 1001);
        assert_eq!(battery.voltage_uv, 3_800_000);
        assert_eq!(battery.current_ua, None);
        assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
    }
}

fn thermal(rows: &str) -> String {
    format!(
        "HAL Ready: true\nCurrent temperatures from HAL:\n{rows}Current cooling devices from HAL:\n"
    )
}

#[test]
fn hal_type_controls_kind_and_battery_hal_suppresses_only_battery_fallback() {
    let result = output(
        UE,
        SERVICE,
        &thermal(
            "Temperature{mValue=45.0, mType=0, mName=gpu-looking-name, mStatus=2}\nTemperature{mValue=46.0, mType=1, mName=gpu, mStatus=1}\nTemperature{mValue=32.0, mType=2, mName=batt-hal, mStatus=0}\nTemperature{mValue=34.0, mType=3, mName=skin, mStatus=0}\n",
        ),
    );
    assert_eq!(result.temperatures.len(), 4);
    assert_eq!(result.temperatures[0].sensor_kind, TemperatureKind::Cpu);
    assert_eq!(result.temperatures[1].sensor_kind, TemperatureKind::Gpu);
    assert_eq!(result.temperatures[2].sensor_kind, TemperatureKind::Battery);
    assert_eq!(result.temperatures[3].sensor_kind, TemperatureKind::Skin);
    for value in result.temperatures {
        assert_eq!(value.source, "thermal_hal_current");
        assert_eq!(value.observed_at, 1002);
        assert!(value.sensor_type.is_some());
    }
}

#[test]
fn absent_debug_frozen_or_out_of_range_observations_are_not_empty_containers() {
    assert!(
        observation(raw("", "", ""), "device".into(), &check)
            .unwrap()
            .is_none()
    );
    let frozen = format!("{SERVICE} (UPDATES STOPPED -- use 'reset' to restart)\n");
    assert!(
        observation(raw("", &frozen, ""), "device".into(), &check)
            .unwrap()
            .is_none()
    );
    let ue = UE.replace("3800000", "50000001").replace("315", "4001");
    assert!(
        observation(raw(&ue, "", ""), "device".into(), &check)
            .unwrap()
            .is_none()
    );
    let ue = UE.replace("-250000", "-100000001");
    let battery = output(&ue, "", "").battery.unwrap();
    assert_eq!(battery.current_ua, None);
    assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
}

#[test]
fn combined_temperature_capacity_and_cancel_remain_failures() {
    let rows = (0..32)
        .map(|index| format!("Temperature{{mValue=40.0, mType=0, mName=cpu-{index}, mStatus=0}}\n"))
        .collect::<String>();
    assert!(matches!(
        observation(raw(UE, SERVICE, &thermal(&rows)), "device".into(), &check),
        Err(super::super::Error::TooLarge)
    ));
    let cancelled = || Err(super::super::Error::Cancelled);
    assert!(matches!(
        observation(raw(UE, SERVICE, ""), "device".into(), &cancelled),
        Err(super::super::Error::Cancelled)
    ));
}

#[test]
fn oem_backup_fallback_preserves_live_values_without_inventing_current_or_power() {
    let service =
        format!("{SERVICE}current now: 321\nBatteryInfoBackUp\nmSavedBatteryMaxTemp: 777\n");
    let result = output("", &service, "");
    let battery = result.battery.unwrap();
    assert_eq!(battery.source, "battery_dumpsys");
    assert_eq!(battery.voltage_uv, 3_800_000);
    assert_eq!(battery.current_ua, None);
    assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
    assert_eq!(battery.net_power_mw(), None);
    assert_eq!(battery.status, Some(BatteryStatus::Discharging));
    assert_eq!(battery.supply_state, BatterySupplyState::Battery);
    assert_eq!(result.temperatures[0].temperature_celsius, 31.5);
}

#[test]
fn oem_backup_cannot_qualify_missing_or_invalid_live_voltage() {
    for (service, backup) in [
        (SERVICE.replace("voltage: 3800\n", ""), "voltage: 9999\n"),
        (
            SERVICE.replace("voltage: 3800", "voltage: invalid"),
            "mSavedVoltage: 9999\n",
        ),
    ] {
        let service = format!("{service}BatteryInfoBackUp\n{backup}");
        let result = output("", &service, "");
        assert_eq!(result.battery, None);
        assert_eq!(result.temperatures[0].temperature_celsius, 31.5);
    }
}

#[test]
fn same_batch_access_covers_sysfs_battery_hal_and_battery_temperature() {
    assert_eq!(
        EnvironmentObservation::default().access,
        ReadAccess::AdbShell
    );
    let temperatures = thermal(
        "Temperature{mValue=45.0, mType=0, mName=cpu, mStatus=1}\nTemperature{mValue=46.0, mType=1, mName=gpu, mStatus=1}\n",
    );
    for (read_access, expected) in [
        (ReadAccess::AdbShell, ObservationAccess::AdbShell),
        (ReadAccess::RootShell, ObservationAccess::RootShell),
    ] {
        let mut observed = raw(UE, SERVICE, &temperatures);
        observed.access = read_access;
        let result = observation(observed, "device".into(), &check)
            .unwrap()
            .unwrap();
        result.validate(1002).unwrap();
        let battery = result.battery.as_ref().unwrap();
        assert_eq!(battery.access, expected);
        assert_eq!(battery.source, "battery_sysfs_uevent");
        assert_eq!(battery.voltage_uv, 3_800_000);
        assert_eq!(battery.current_ua, Some(-250_000));
        assert_eq!(battery.net_power_mw(), Some(-950.0));
        assert_eq!(result.temperatures.len(), 3);
        for temperature in &result.temperatures {
            assert_eq!(temperature.access, expected);
        }
        assert_eq!(result.temperatures[0].source, "thermal_hal_current");
        assert_eq!(result.temperatures[1].source, "thermal_hal_current");
        assert_eq!(result.temperatures[2].source, "battery_sysfs_uevent");
        assert_eq!(result.temperatures[2].temperature_celsius, 31.5);
    }
}

#[test]
fn same_batch_access_preserves_service_fallback_and_hal_battery_override() {
    for (read_access, expected) in [
        (ReadAccess::AdbShell, ObservationAccess::AdbShell),
        (ReadAccess::RootShell, ObservationAccess::RootShell),
    ] {
        for temperatures in [
            String::new(),
            thermal("Temperature{mValue=32.0, mType=2, mName=batt-hal, mStatus=0}\n"),
        ] {
            let mut observed = raw("", SERVICE, &temperatures);
            observed.access = read_access;
            let result = observation(observed, "device".into(), &check)
                .unwrap()
                .unwrap();
            result.validate(1002).unwrap();
            let battery = result.battery.as_ref().unwrap();
            assert_eq!(battery.access, expected);
            assert_eq!(battery.source, "battery_dumpsys");
            assert_eq!(battery.voltage_uv, 3_800_000);
            assert_eq!(battery.current_ua, None);
            assert_eq!(battery.current_polarity, CurrentPolarity::Unknown);
            assert_eq!(battery.net_power_mw(), None);
            assert_eq!(result.temperatures.len(), 1);
            let temperature = &result.temperatures[0];
            assert_eq!(temperature.access, expected);
            if temperatures.is_empty() {
                assert_eq!(temperature.source, "battery_dumpsys");
                assert_eq!(temperature.temperature_celsius, 31.5);
            } else {
                assert_eq!(temperature.source, "thermal_hal_current");
                assert_eq!(temperature.temperature_celsius, 32.0);
            }
        }
    }
}
