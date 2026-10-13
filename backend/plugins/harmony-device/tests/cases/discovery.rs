use crate::{
    input::{discovered, qualified_discovery, unfinished_discovery},
    support::{Fixture, failure, success},
};
use serde_json::{Value, json};

fn discover(bytes: &[u8]) -> Value {
    let fixture = Fixture::new("discovery");
    let reply = fixture.run("discover", json!({}), bytes, b"", 0);
    assert_eq!(fixture.argv(), ["list", "targets"]);
    reply
}

#[test]
fn discovery_trimmed_ids_keep_order_and_eight_existing_plus_qualified_input_capabilities() {
    assert_eq!(
        success(&qualified_discovery(
            b" HDC001 \r\n\n[Empty]\n127.0.0.1:5555\n",
            &["HDC001", "127.0.0.1:5555"]
        )),
        &json!([
            discovered("HDC001", true, None),
            discovered("127.0.0.1:5555", true, None)
        ])
    );
}

#[test]
fn known_empty_marker_and_whitespace_only_produce_explicit_empty_array() {
    for output in [
        b"[Empty]\r\n".as_slice(),
        b"\r\n \n".as_slice(),
        b"".as_slice(),
    ] {
        assert_eq!(success(&discover(output)), &json!([]));
    }
}

#[test]
fn duplicate_unknown_diagnostic_and_bad_id_reject_entire_directory() {
    for output in [
        "valid\nvalid\n",
        "valid\n[Error]\n",
        "valid\nbad device\n",
        "valid\n-flag\n",
        "valid\n设备\n",
        "valid\nhdc: connection error:\n",
    ] {
        failure(
            &discover(output.as_bytes()),
            "工具依赖失败：HDC发现条目无效、重复或超过128条",
        );
    }
}

#[test]
fn control_character_in_second_line_rejects_first_valid_entry_too() {
    for output in ["valid\nsecond\t\n", "valid\nsecond\u{7}\n"] {
        failure(
            &discover(output.as_bytes()),
            "工具依赖失败：HDC发现输出含非法控制符",
        );
    }
}

#[test]
fn discovery_exact_128_count_and_200_byte_serial_boundaries_are_accepted() {
    let ids: Vec<String> = (0..128).map(|index| format!("HDC{index:03}")).collect();
    let expected: Vec<Value> = ids
        .iter()
        .map(|id| discovered(id, false, Some("本次发现未完成输入资格探测")))
        .collect();
    assert_eq!(
        success(&unfinished_discovery(ids.join("\n").as_bytes(), &ids[0])),
        &json!(expected)
    );
    let serial = "S".repeat(200);
    assert_eq!(
        success(&qualified_discovery(serial.as_bytes(), &[&serial])),
        &json!([discovered(&serial, true, None)])
    );
}

#[test]
fn discovery_count_and_serial_overflow_fail_without_partial_array() {
    for output in [
        (0..129)
            .map(|index| format!("HDC{index:03}"))
            .collect::<Vec<_>>()
            .join("\n"),
        format!("valid\n{}", "S".repeat(201)),
    ] {
        failure(
            &discover(output.as_bytes()),
            "工具依赖失败：HDC发现条目无效、重复或超过128条",
        );
    }
}

#[test]
fn discovery_invalid_utf8_stderr_failure_and_nonzero_exit_are_fixed_errors() {
    for (stdout, stderr, code, expected) in [
        (
            &[0xff][..],
            b"".as_slice(),
            0,
            "工具依赖失败：HDC发现输出不是有效UTF-8",
        ),
        (
            b"HDC001\n".as_slice(),
            b"error: private diagnostic".as_slice(),
            0,
            "工具依赖失败：HDC返回失败诊断",
        ),
        (
            b"HDC001\n".as_slice(),
            b"".as_slice(),
            7,
            "工具依赖失败：HDC客户端执行失败，请检查部署配置",
        ),
    ] {
        let fixture = Fixture::new("discovery-failure");
        failure(
            &fixture.run("discover", json!({}), stdout, stderr, code),
            expected,
        );
    }
}
