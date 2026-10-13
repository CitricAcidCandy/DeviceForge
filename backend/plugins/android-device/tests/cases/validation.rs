//! 严格封套与零副作用；所有错误精确匹配公开文案，不接受任意Err。
use crate::support::{self, Fixture, SERIAL, failure, success};
use serde_json::{Value, json};
use std::time::Duration;

fn reject(operation: &str, input: Value, expected: &str) {
    let fixture = Fixture::new("invalid-input");
    let mut running = fixture.begin(operation, input);
    running.start(Duration::from_secs(20));
    failure(&running.complete(), expected);
    fixture.assert_no_tool();
}

#[test]
fn full_external_names_and_unknown_short_names_are_not_accepted() {
    for name in [
        "plugin.android-device.discover",
        "plugin.android-device.packages",
        "android.packages",
        "install",
    ] {
        reject(
            name,
            json!({}),
            "输入无效：设备插件只接受本批十二个短贡献名",
        );
    }
}

#[test]
fn provider_envelope_requires_both_fields_and_explicit_null() {
    for input in [
        json!({"input":{"address":"host.example:5555"}}),
        json!({"device_id":null}),
    ] {
        reject(
            "connect",
            input,
            "输入无效：设备动作封套必须显式提供device_id和input",
        );
    }
    for serial in [json!(SERIAL), json!(0), json!(false)] {
        reject(
            "connect",
            json!({"device_id":serial,"input":{"address":"host.example:5555"}}),
            "输入无效：提供者动作的device_id必须为显式null",
        );
    }
}

#[test]
fn envelope_business_action_unknown_fields_and_null_boolean_are_rejected() {
    for (operation, value) in [
        ("discover", json!({"extra":1})),
        (
            "packages",
            json!({"device_id":SERIAL,"input":{},"provider_id":"android-device"}),
        ),
        ("packages", support::device(json!({"extra":1}))),
        (
            "connect",
            support::provider(json!({"address":"host.example:5555","adb":"other"})),
        ),
        (
            "app.start",
            support::device(json!({"package":"com.example.app","extra":1})),
        ),
        (
            "input",
            support::device(json!({"action":{"kind":"tap","x":1,"y":2},"extra":1})),
        ),
        (
            "input",
            support::input(json!({"kind":"tap","x":1,"y":2,"extra":1})),
        ),
        (
            "input",
            support::input(json!({"kind":"keyevent","key_code":66,"long_press":null})),
        ),
        (
            "input",
            support::input(json!({"kind":"text","text":"A","enter":null})),
        ),
    ] {
        reject(
            operation,
            value,
            "输入无效：设备动作封套或业务字段不符合严格格式",
        );
    }
}

#[test]
fn discover_and_nested_business_require_object() {
    for input in [json!(null), json!([]), json!(""), json!(3)] {
        reject(
            "discover",
            input.clone(),
            "输入无效：设备动作及业务输入必须为对象",
        );
        reject(
            "packages",
            support::device(input),
            "输入无效：设备动作及业务输入必须为对象",
        );
    }
}

#[test]
fn device_serial_rejects_controls_leading_option_and_utf8_byte_overflow() {
    for serial in [
        "".to_owned(),
        "  ".to_owned(),
        "-serial".to_owned(),
        "a\nb".to_owned(),
        "a\u{85}b".to_owned(),
        "x".repeat(201),
        format!("{}a", "中".repeat(67)),
    ] {
        reject(
            "packages",
            support::envelope(Some(&serial), json!({})),
            "输入无效：设备标识须为不含控制符的有效原文，最多200字节",
        );
    }
    for serial in [json!(null), json!(1), json!({})] {
        reject(
            "packages",
            json!({"device_id":serial,"input":{}}),
            "输入无效：设备动作的device_id必须为字符串",
        );
    }
}

#[test]
fn device_serial_exact_200_utf8_bytes_and_wide_original_are_preserved() {
    for serial in [
        format!("{}ab", "中".repeat(66)),
        " space@设备:#% ".to_owned(),
    ] {
        let fixture = Fixture::new("wide-serial");
        let reply = fixture.run(
            "packages",
            support::envelope(Some(&serial), json!({})),
            &[b""],
        );
        assert_eq!(success(&reply), &json!({"output":""}));
        assert_eq!(fixture.argv(1)[1], serial, "不trim、不收紧ASCII、不拆argv");
    }
}

#[test]
fn address_and_package_safety_errors_have_precise_categories() {
    for address in [
        "localhost",
        "host:0",
        "[::1]:65536",
        "::1:5555",
        "999.999.1.1:5",
    ] {
        reject(
            "connect",
            support::provider(json!({"address":address})),
            "输入无效：连接地址必须包含合法主机和1至65535端口，IPv6须加方括号",
        );
    }
    for address in ["host:5 --flag", "主机:5", "host:5\n"] {
        reject(
            "disconnect",
            support::provider(json!({"address":address})),
            "输入无效：连接地址须为不含空白的host:port，最多200字节",
        );
    }
    for name in ["old_identifier", "com..app", "com.1app", "com.app;other"] {
        reject(
            "app.start",
            support::device(json!({"package":name})),
            "输入无效：应用包名须为最多200字节的点分ASCII标识",
        );
    }
}

#[test]
fn input_ranges_and_invalid_text_are_rejected_before_tool() {
    for action in [
        json!({"kind":"tap","x":32768,"y":0}),
        json!({"kind":"swipe","x1":0,"y1":0,"x2":1,"y2":1,"duration_ms":0}),
        json!({"kind":"swipe","x1":0,"y1":0,"x2":1,"y2":1,"duration_ms":10001}),
        json!({"kind":"keyevent","key_code":0}),
        json!({"kind":"keyevent","key_code":65536}),
        json!({"kind":"text","text":""}),
        json!({"kind":"text","text":"a\nb"}),
        json!({"kind":"text","text":"a".repeat(1025)}),
    ] {
        reject(
            "input",
            support::input(action),
            "输入无效：输入动作参数超出坐标、时间、按键或ASCII文本限额",
        );
    }
}

#[test]
fn non_ascii_text_requires_explicit_adb_keyboard_configuration() {
    let fixture = Fixture::new("unicode-input-without-config");
    let mut running = fixture.begin(
        "input",
        support::input(json!({
            "kind": "text",
            "text": "中文"
        })),
    );
    running.start(Duration::from_secs(20));
    failure(
        &running.complete(),
        "工具依赖失败：未配置ADB Keyboard Unicode输入",
    );
    fixture.assert_no_tool();
}

#[test]
fn nonempty_artifact_context_is_rejected_before_bad_config_or_tool() {
    let fixture = Fixture::new("nonempty-artifacts");
    std::fs::write(&fixture.config_path, b"not-json").unwrap();
    let mut request = fixture.request("packages", support::device(json!({})));
    request["artifacts"]["inputs"] = json!([{"field":"artifact_id","artifact_id":"unused","filename":"unused.bin",
        "size":0,"sha256":"0".repeat(64),"path":fixture.root.join("not-read.bin")}]);
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    failure(&running.complete(), "输入无效：该设备动作不接受输入产物");
    fixture.assert_no_tool();
}

#[test]
fn absent_and_some_empty_null_output_artifact_context_remain_legal() {
    for present in [false, true] {
        let fixture = Fixture::new("empty-artifacts");
        fixture.plan(1, b"", b"", 0);
        let mut request = fixture.request("packages", support::device(json!({})));
        if present {
            request["artifacts"]["output_directory"] = json!(null);
        } else {
            request.as_object_mut().unwrap().remove("artifacts");
        }
        let mut running = fixture.begin_request(request);
        running.start(Duration::from_secs(20));
        let probe = fixture.wait_tool(1);
        fixture.release(1);
        probe.assert_exited();
        assert_eq!(success(&running.complete()), &json!({"output":""}));
        fixture.assert_calls(1);
    }
}

#[test]
fn unknown_request_field_and_wrong_start_id_are_transport_errors_with_zero_tools() {
    let fixture = Fixture::new("bad-request-field");
    let mut request = fixture.request("discover", json!({}));
    request["extra"] = json!(1);
    fixture
        .begin_bad_request(request)
        .reject_transport("安卓设备插件协议失败：请求不符合公开协议");
    fixture.assert_no_tool();
    let fixture = Fixture::new("bad-start-id");
    let mut running = fixture.begin("discover", json!({}));
    let mut start = running.start_frame(Duration::from_secs(20));
    start["request_id"] = json!("other");
    running.send(&start);
    running.reject_transport("安卓设备插件协议失败：Start 请求 ID 不匹配");
    fixture.assert_no_tool();
}
