//! 完整发现纯解析回归；坏条目不能被过滤成部分成功目录。
use super::*;

#[test]
fn normalized_state_keeps_all_special_and_unknown_raw_tokens() {
    let output = "List of devices attached\nnormal\tdevice model:Pixel_8\noff\toffline\nunauth\tunauthorized\nrecover\trecovery\nside\tsideload\nboot\tbootloader\nvendor\tVendor.状态\n";
    let devices = parse(output).unwrap();
    assert_eq!(devices.len(), 7);
    for (device, raw) in devices.iter().zip([
        "device",
        "offline",
        "unauthorized",
        "recovery",
        "sideload",
        "bootloader",
        "Vendor.状态",
    ]) {
        assert_eq!(device.raw_state.as_deref(), Some(raw));
        assert_eq!(device.capabilities.len(), 10);
        assert!(
            device
                .capabilities
                .iter()
                .all(|cap| cap.version == 1 && cap.available == (raw == "device"))
        );
        assert!(
            device
                .capabilities
                .iter()
                .all(|cap| !matches!(cap.id.as_str(), "connect" | "disconnect"))
        );
        assert!(
            device
                .capabilities
                .iter()
                .all(|cap| cap.reason.is_none() == (raw == "device"))
        );
    }
    assert_eq!(devices[0].state, DeviceState::Online);
    assert_eq!(devices[1].state, DeviceState::Offline);
    assert_eq!(devices[2].state, DeviceState::Unauthorized);
    assert!(
        devices[3..]
            .iter()
            .all(|device| device.state == DeviceState::Unknown)
    );
    assert_eq!(devices[0].model.as_deref(), Some("Pixel_8"));
    assert!(devices[1].model.is_none());
}

#[test]
fn exact_adb_headers_daemon_messages_and_empty_lines_are_not_devices() {
    let output = "\r\nList of devices attached\r\n* daemon not running; starting now at tcp:5037\r\n* daemon started successfully\r\n* daemon not running. starting it now on port 5037 *\r\n* daemon started successfully *\r\n\r\n";
    assert!(parse(output).unwrap().is_empty());
    assert!(parse("").unwrap().is_empty());
    let devices =
        parse("设备:一\tunknown.mode product:产品 model:型号 device:型号 transport_id:1\n")
            .unwrap();
    assert_eq!(devices[0].id, "设备:一");
    assert_eq!(devices[0].raw_state.as_deref(), Some("unknown.mode"));
    assert_eq!(devices[0].model.as_deref(), Some("型号"));
}

#[test]
fn raw_state_100_utf8_bytes_is_kept_but_101_and_controls_fail_whole_discovery() {
    let raw = format!("{}a", "汉".repeat(33));
    let devices = parse(&format!("serial\t{raw}\n")).unwrap();
    assert_eq!(devices[0].raw_state.as_deref(), Some(raw.as_str()));
    for raw in [
        format!("{raw}b"),
        "bad\u{85}state".into(),
        "bad\0state".into(),
        "bad\u{7f}state".into(),
    ] {
        assert!(matches!(
            parse(&format!("valid\tdevice\ninvalid\t{raw}\n")),
            Err(Error::Dependency(_))
        ));
    }
    assert!(matches!(
        parse("valid\tdevice\ninvalid\t \n"),
        Err(Error::Dependency(_))
    ));
}

#[test]
fn serial_and_model_byte_limits_match_the_public_host_rules() {
    let serial = format!("{}ab", "汉".repeat(66));
    let model = format!("{}ab", "型".repeat(66));
    let devices = parse(&format!("{serial}\tdevice model:{model}\n")).unwrap();
    assert_eq!(devices[0].id, serial);
    assert_eq!(devices[0].model.as_deref(), Some(model.as_str()));
    for line in [
        format!("{serial}x\tdevice"),
        format!("serial\tdevice model:{model}x"),
        "-serial\tdevice".into(),
        "serial\tdevice model:".into(),
        "serial\tdevice model:first model:second".into(),
        "serial\tdevice model:bad\u{85}model".into(),
    ] {
        assert!(matches!(
            parse(&format!("valid\tdevice\n{line}\n")),
            Err(Error::Dependency(_))
        ));
    }
}

#[test]
fn duplicate_ids_or_bad_late_rows_reject_the_entire_directory() {
    for output in [
        "same\tdevice\nsame\toffline\n",
        "valid\tdevice\nmissing-state\n",
        "valid\tdevice\nerror: device offline\n",
        "valid\tdevice\nadb: device 'missing' not found\n",
    ] {
        assert!(matches!(parse(output), Err(Error::Dependency(_))));
    }
}

#[test]
fn discovery_accepts_128_devices_and_rejects_a_129th() {
    let output: String = (0..128)
        .map(|index| format!("device-{index}\tdevice\n"))
        .collect();
    assert_eq!(parse(&output).unwrap().len(), 128);
    assert!(matches!(
        parse(&format!("{output}extra\tdevice\n")),
        Err(Error::Dependency(_))
    ));
}

#[test]
fn raw_state_is_case_sensitive_and_unknown_is_not_silently_discarded() {
    let devices = parse("case\tDevice\ncustom\tCustom-State\n").unwrap();
    assert_eq!(devices.len(), 2);
    assert!(
        devices
            .iter()
            .all(|device| device.state == DeviceState::Unknown)
    );
    assert_eq!(devices[0].raw_state.as_deref(), Some("Device"));
    assert_eq!(devices[1].raw_state.as_deref(), Some("Custom-State"));
    assert!(
        devices
            .iter()
            .flat_map(|device| &device.capabilities)
            .all(|cap| !cap.available)
    );
}

#[test]
fn diagnostic_words_in_tab_delimited_serials_keep_the_public_identity() {
    let devices =
        parse("error:serial\tdevice model:Pixel\nerror:\tdevice\nadb:\tdevice\n").unwrap();
    assert_eq!(devices.len(), 3);
    assert_eq!(devices[0].id, "error:serial");
    assert_eq!(devices[1].id, "error:");
    assert_eq!(devices[2].id, "adb:");
    assert!(
        devices
            .iter()
            .all(|device| device.state == DeviceState::Online)
    );
    for diagnostic in [
        "error: device offline",
        "error: device offline\t",
        "adb: device xxx not found\t",
    ] {
        assert!(matches!(
            parse(&format!("valid\tdevice\n{diagnostic}\n")),
            Err(Error::Dependency(_))
        ));
    }
}
