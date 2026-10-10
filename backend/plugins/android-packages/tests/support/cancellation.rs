//! 真实协议 4 的零执行与运行中收口；看门狗只防挂起，不是性能证据。
use crate::support::{self, Fixture, wire::failure};
use serde_json::json;
use std::{fs, thread, time::Duration};

const CANCELLED: &str = "操作已取消或宿主连接已关闭";
const TIMEOUT: &str = "插件执行期限已到期";

#[test]
fn zero_start_budget_rejects_before_reading_bad_configuration_or_tool() {
    let fixture = Fixture::new("输入.apk", support::apk());
    fs::write(&fixture.config_path, b"bad-json-must-not-be-read").unwrap();
    let mut invocation = fixture.begin("manifest", json!({}));
    invocation.start(Duration::ZERO);
    failure(&invocation.complete(), TIMEOUT);
    fixture.assert_no_tool();
    fixture.assert_no_output();
    fixture.assert_released();
}

#[test]
fn delayed_start_does_not_restart_budget_after_ready() {
    let fixture = Fixture::new("输入.apk", support::apk());
    fs::write(&fixture.config_path, b"bad-json-must-not-be-read").unwrap();
    let mut invocation = fixture.begin("manifest", json!({}));
    // C0 已先于收到 Ready；延迟远大于一纳秒，但不据此报告精确时延。
    thread::sleep(Duration::from_millis(100));
    invocation.start(Duration::from_nanos(1));
    failure(&invocation.complete(), TIMEOUT);
    fixture.assert_no_tool();
    fixture.assert_no_output();
    fixture.assert_released();
}

#[test]
fn malformed_start_id_version_and_unknown_fields_reject_without_handler() {
    for (field, value, expected) in [
        (
            "request_id",
            json!("another-request"),
            "安卓包插件协议失败：Start 请求 ID 不匹配",
        ),
        (
            "protocol_version",
            json!(3),
            "安卓包插件协议失败：Start 帧无效",
        ),
        (
            "unexpected",
            json!(true),
            "安卓包插件协议失败：Start 帧无效",
        ),
    ] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut invocation = fixture.begin("manifest", json!({}));
        let mut start = json!({"protocol_version":4,"request_id":"blackbox-manifest","command":"start","remaining_timeout_ns":20_000_000_000_u64});
        start[field] = value;
        invocation.send(&start);
        invocation.reject_handshake(expected);
        fixture.assert_no_tool();
        fixture.assert_no_output();
        fixture.assert_released();
    }
}

fn running_cancel(operation: &str, name: &str, bytes: Vec<u8>, input: serde_json::Value) {
    let fixture = Fixture::new(name, bytes);
    let mut invocation = fixture.begin(operation, input);
    invocation.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    probe.assert_running();
    invocation.cancel("cancelled");
    failure(&invocation.complete(), CANCELLED);
    probe.assert_exited();
    fixture.assert_no_output();
    fixture.assert_released();
    assert!(
        !fixture.tools.join("response_written").exists(),
        "hold 中取消不得冒称工具已完成"
    );
}

#[test]
fn cancel_manifest_waits_for_same_tool_pid_and_private_lease_release() {
    running_cancel("manifest", "输入.apk", support::apk(), json!({}));
}

#[test]
fn cancel_build_monitor_does_not_publish_or_delete_signing_material() {
    running_cancel(
        "build_apks",
        "输入.aab",
        support::aab(),
        json!({"mode":"universal"}),
    );
}

#[test]
fn cancel_decode_monitor_waits_for_tool_and_cleans_private_tree() {
    running_cancel("decode", "输入.apk", support::apk(), json!({}));
}

#[test]
fn cancel_split_monitor_does_not_publish_zip() {
    running_cancel(
        "extract_splits",
        "输入.apks",
        support::apks(),
        json!({"device_spec":support::device_spec()}),
    );
}

#[test]
fn local_deadline_stops_hold_tool_and_rejects_success_without_publication() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut invocation = fixture.begin("manifest", json!({}));
    invocation.start(Duration::from_secs(8));
    let probe = fixture.wait_tool();
    probe.assert_running();
    failure(&invocation.complete(), TIMEOUT);
    probe.assert_exited();
    fixture.assert_no_output();
    fixture.assert_released();
    assert!(!fixture.tools.join("response_written").exists());
}

#[test]
fn timeout_control_reason_remains_timeout_during_running_tool() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut invocation = fixture.begin("manifest", json!({}));
    invocation.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    invocation.cancel("timeout");
    failure(&invocation.complete(), TIMEOUT);
    probe.assert_exited();
    fixture.assert_no_output();
    fixture.assert_released();
}

#[test]
fn eof_after_tool_ready_is_cancelled_and_not_cleanup_by_test_kill() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut invocation = fixture.begin("manifest", json!({}));
    invocation.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    invocation.eof();
    failure(&invocation.complete(), CANCELLED);
    probe.assert_exited();
    fixture.assert_no_output();
    fixture.assert_released();
}

#[test]
fn duplicate_start_is_invalid_control_and_cannot_renew_the_invocation() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut invocation = fixture.begin("manifest", json!({}));
    invocation.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    invocation.start(Duration::from_secs(60));
    failure(&invocation.complete(), "控制帧无效");
    probe.assert_exited();
    fixture.assert_no_output();
    fixture.assert_released();
}
