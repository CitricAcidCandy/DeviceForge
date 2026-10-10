//! 真实进程门闩与总D收口；墙钟等待只验证期限行为，不推性能或daemon清理。
use crate::support::{self, CANCELLED, Fixture, TOTAL_TIMEOUT, failure};
use serde_json::json;
use std::{
    fs, thread,
    time::{Duration, Instant},
};

#[test]
fn zero_start_budget_rejects_before_config_and_adb() {
    let fixture = Fixture::new("start-zero");
    fs::write(&fixture.config_path, b"invalid-json").unwrap();
    let mut running = fixture.begin("discover", json!({}));
    running.start(Duration::ZERO);
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_no_tool();
}

#[test]
fn delayed_start_consumes_origin_budget_and_does_not_restart_clock() {
    let fixture = Fixture::new("late-start");
    let mut running = fixture.begin("discover", json!({}));
    // Ready已观测，故C0必定更早；500ms实际等待严格超过200ms传入预算。
    thread::sleep(Duration::from_millis(500));
    running.start(Duration::from_millis(200));
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_no_tool();
}

#[test]
fn start_and_queued_cancel_in_one_write_prevent_first_tool_poll() {
    let fixture = Fixture::new("pre-cancel");
    let mut running = fixture.begin("packages", support::device(json!({})));
    let frames = [
        running.start_frame(Duration::from_secs(20)),
        running.cancel_frame("cancelled"),
    ];
    running.send_batch(&frames);
    failure(&running.complete(), CANCELLED);
    fixture.assert_no_tool();
}

#[test]
fn running_cancel_confirms_same_adb_pid_exit_before_complete() {
    let fixture = Fixture::new("running-cancel");
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin("packages", support::device(json!({})));
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    probe.assert_running();
    running.cancel("cancelled");
    failure(&running.complete(), CANCELLED);
    probe.assert_exited();
    fixture.assert_calls(1);
    assert!(
        !fixture.root.join("release-1").exists(),
        "工具没有自然放行，不借正常结束冒充取消"
    );
}

#[test]
fn stdin_eof_cancels_running_adb_and_does_not_return_late_success() {
    let fixture = Fixture::new("running-eof");
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin(
        "app.stop",
        support::device(json!({"package":"com.example.app"})),
    );
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    running.eof();
    failure(&running.complete(), CANCELLED);
    probe.assert_exited();
    fixture.assert_calls(1);
}

#[test]
fn shared_total_deadline_stops_hold_tool_without_success_result() {
    let fixture = Fixture::new("total-deadline");
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin("packages", support::device(json!({})));
    running.start(Duration::from_secs(5));
    let probe = fixture.wait_tool(1);
    probe.assert_running();
    failure(&running.complete(), TOTAL_TIMEOUT);
    probe.assert_exited();
    fixture.assert_calls(1);
    assert!(!fixture.root.join("release-1").exists());
}

#[test]
fn connect_five_second_short_point_precedes_twenty_second_context() {
    let fixture = Fixture::new("connect-short-point");
    fixture.plan(1, b"connected to host:5555", b"", 0);
    let mut running = fixture.begin("connect", support::provider(json!({"address":"host:5555"})));
    let before = Instant::now();
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    failure(&running.complete(), "插件或工具执行期限已到期");
    probe.assert_exited();
    fixture.assert_calls(1);
    assert!(
        before.elapsed() >= Duration::from_secs(5),
        "工具短点没有提前触发"
    );
    assert!(
        before.elapsed() < Duration::from_secs(20),
        "不能借总D到期覆盖短点错误映射"
    );
    fs::write(fixture.root.join("short-point.json"),serde_json::to_vec(&json!({"context_budget_ms":20000,
        "tool_limit_ms":5000,"elapsed_ms":before.elapsed().as_millis(),"short_point_error":"插件或工具执行期限已到期",
        "host_error_boundary":"原帧字符串，HTTP宿主分类待服务验收"})).unwrap()).unwrap();
}

#[test]
fn all_text_subcommands_consume_same_nine_second_origin() {
    let fixture = Fixture::new("text-shared-deadline");
    for index in 1..=3 {
        fixture.plan(index, b"", b"", 0);
    }
    let mut running = fixture.begin(
        "input",
        support::input(json!({"kind":"text","text":"a%sb","enter":true})),
    );
    let origin_upper_bound = running.ready_observed;
    running.start(Duration::from_secs(9));
    let first = fixture.wait_tool(1);
    thread::sleep(
        (origin_upper_bound + Duration::from_secs(3)).saturating_duration_since(Instant::now()),
    );
    fixture.release(1);
    first.assert_exited();
    let second = fixture.wait_tool(2);
    thread::sleep(
        (origin_upper_bound + Duration::from_secs(6)).saturating_duration_since(Instant::now()),
    );
    fixture.release(2);
    second.assert_exited();
    let third = fixture.wait_tool(3);
    third.assert_running();
    failure(&running.complete(), TOTAL_TIMEOUT);
    third.assert_exited();
    fixture.assert_calls(3);
    // C0早于Ready观测；原9s加公开2s清理及观测余量，不是给生产刷新预算。
    assert!(
        origin_upper_bound.elapsed() <= Duration::from_secs(12),
        "第三笔不能重新取得9s"
    );
    assert!(!fixture.root.join("release-3").exists());
    assert_eq!(fixture.argv(1).last().unwrap(), "'a%'");
    assert_eq!(fixture.argv(2).last().unwrap(), "'sb'");
    assert_eq!(fixture.argv(3).last().unwrap(), "66");
    fs::write(fixture.root.join("same-origin.json"),serde_json::to_vec(&json!({"budget_ms":9000,
        "release_points_from_ready_ms":[3000,6000],"calls":3,"completed_elapsed_ms":origin_upper_bound.elapsed().as_millis(),
        "third_released":false,"origin_boundary":"Ready观测只作C0上界，未读或重设插件内部Instant"})).unwrap()).unwrap();
}

#[test]
fn malformed_cancel_identity_is_exact_protocol_failure_and_still_cleans_client() {
    let fixture = Fixture::new("bad-control-id");
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin("packages", support::device(json!({})));
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    let mut cancel = running.cancel_frame("cancelled");
    cancel["request_id"] = json!("another-request");
    running.send(&cancel);
    failure(&running.complete(), "控制帧版本或请求 ID 不匹配");
    probe.assert_exited();
    fixture.assert_calls(1);
}
