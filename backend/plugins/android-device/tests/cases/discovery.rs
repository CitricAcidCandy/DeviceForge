//! 原文/未知状态/整份失败与字节边界；假发现不算当前代宿主目录发布。
use crate::support::{Fixture, expected_device, failure, success};
use serde_json::{Value, json};

fn discover(bytes: &[u8]) -> Value {
    Fixture::new("discovery-output").run("discover", json!({}), &[bytes])
}

#[test]
fn discovery_keeps_unknown_raw_states_and_only_online_device_capabilities() {
    let output = "List of devices attached\n* daemon not running; starting now at tcp:5037\n* daemon started successfully\n设备:@# device model:Pixel_中文\na offline\nb unauthorized\nc recovery\nd sideload\ne bootloader\nf Vendor.Mode\ng DEVICE\n";
    let expected = vec![
        expected_device("设备:@#", "device", "online", Some("Pixel_中文"), None),
        expected_device("a", "offline", "offline", None, Some("设备离线")),
        expected_device(
            "b",
            "unauthorized",
            "unauthorized",
            None,
            Some("设备尚未授权"),
        ),
        expected_device(
            "c",
            "recovery",
            "unknown",
            None,
            Some("设备原始状态暂不允许动作"),
        ),
        expected_device(
            "d",
            "sideload",
            "unknown",
            None,
            Some("设备原始状态暂不允许动作"),
        ),
        expected_device(
            "e",
            "bootloader",
            "unknown",
            None,
            Some("设备原始状态暂不允许动作"),
        ),
        expected_device(
            "f",
            "Vendor.Mode",
            "unknown",
            None,
            Some("设备原始状态暂不允许动作"),
        ),
        expected_device(
            "g",
            "DEVICE",
            "unknown",
            None,
            Some("设备原始状态暂不允许动作"),
        ),
    ];
    assert_eq!(success(&discover(output.as_bytes())), &json!(expected));
}

#[test]
fn empty_adb_list_is_an_empty_public_array() {
    assert_eq!(
        success(&discover(b"List of devices attached\n\n")),
        &json!([])
    );
}

#[test]
fn duplicate_serial_rejects_whole_result_including_first_valid_device() {
    failure(
        &discover(b"List of devices attached\nfirst device\nfirst offline\n"),
        "工具依赖失败：设备发现超过128条或包含重复标识",
    );
}

#[test]
fn serial_raw_state_and_model_exact_utf8_limits_are_accepted() {
    let serial = format!("{}ab", "中".repeat(66));
    let raw = format!("{}a", "中".repeat(33));
    let model = format!("{}ab", "模".repeat(66));
    assert_eq!(serial.len(), 200);
    assert_eq!(raw.len(), 100);
    assert_eq!(model.len(), 200);
    let output = format!("List of devices attached\n{serial}\t{raw} model:{model}\n");
    assert_eq!(
        success(&discover(output.as_bytes())),
        &json!([expected_device(
            &serial,
            &raw,
            "unknown",
            Some(&model),
            Some("设备原始状态暂不允许动作")
        )])
    );
}

#[test]
fn raw_state_or_serial_overflow_after_valid_entry_returns_no_partial_success() {
    for line in [
        format!("second {}", "x".repeat(101)),
        format!("{} device", "x".repeat(201)),
        "-serial device".to_owned(),
    ] {
        failure(
            &discover(format!("List of devices attached\nfirst device\n{line}\n").as_bytes()),
            "工具依赖失败：设备发现标识或原始状态不符合资格",
        );
    }
}

#[test]
fn missing_state_and_control_characters_are_exact_discovery_errors() {
    failure(
        &discover(b"List of devices attached\nfirst device\nsecond\n"),
        "工具依赖失败：设备发现条目缺少原始状态",
    );
    for output in [
        "first device\nsecond bad\u{85}state\n",
        "first device\nsecond device model:bad\u{7}name\n",
    ] {
        failure(
            &discover(output.as_bytes()),
            "工具依赖失败：设备发现输出含非法控制符",
        );
    }
}

#[test]
fn model_empty_duplicate_and_byte_overflow_reject_whole_result() {
    for line in [
        "second device model:".to_owned(),
        "second device model:A model:B".to_owned(),
        format!("second device model:{}", "模".repeat(67)),
    ] {
        failure(
            &discover(format!("first device\n{line}\n").as_bytes()),
            "工具依赖失败：设备发现型号不符合资格",
        );
    }
}

#[test]
fn discovery_accepts_128_but_rejects_129_entries() {
    let mut output = "List of devices attached\n".to_owned();
    let mut expected = Vec::new();
    for index in 0..128 {
        let id = format!("serial-{index:03}");
        output.push_str(&format!("{id} device\n"));
        expected.push(expected_device(&id, "device", "online", None, None));
    }
    assert_eq!(success(&discover(output.as_bytes())), &json!(expected));
    output.push_str("serial-128 device\n");
    failure(
        &discover(output.as_bytes()),
        "工具依赖失败：设备发现超过128条或包含重复标识",
    );
}

#[test]
fn diagnostic_line_and_invalid_utf8_are_not_silent_empty_discovery() {
    failure(
        &discover(b"first device\nadb: device offline\n"),
        "工具依赖失败：ADB未返回有效设备目录",
    );
    failure(
        &discover(&[0xff, 0xfe, b'\n']),
        "工具依赖失败：ADB输出不是有效UTF-8文本",
    );
}
