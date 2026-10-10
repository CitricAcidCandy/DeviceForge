//! 零退出并不保证业务成功；两路输入输出单独校验并拒绝晚续命令。
use crate::support::{self, ACTION_FAILURE, BAD_UTF8, Fixture, INPUT_FAILURE, failure, success};
use serde_json::{Value, json};
use std::time::Duration;

fn output_case(
    operation: &str,
    input: Value,
    stdout: &[u8],
    stderr: &[u8],
    code: i32,
    expected: &str,
) {
    let fixture = Fixture::new("output-error");
    fixture.plan(1, stdout, stderr, code);
    let mut running = fixture.begin(operation, input);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    fixture.release(1);
    probe.assert_exited();
    failure(&running.complete(), expected);
    fixture.assert_calls(1);
}

#[test]
fn connect_zero_exit_without_explicit_success_is_rejected() {
    for output in [
        b"Success\n".as_slice(),
        b"connecting...\n",
        b"unable to connect\n",
    ] {
        output_case(
            "connect",
            support::provider(json!({"address":"host.example:5555"})),
            output,
            b"",
            0,
            ACTION_FAILURE,
        );
    }
}

#[test]
fn connect_already_connected_is_explicit_success() {
    let fixture = Fixture::new("already-connected");
    let reply = fixture.run(
        "connect",
        support::provider(json!({"address":"host.example:5555"})),
        &[b"already connected to host.example:5555\n"],
    );
    assert_eq!(
        success(&reply),
        &json!({"output":"already connected to host.example:5555"})
    );
}

#[test]
fn packages_exact_diagnostic_fails_even_after_valid_package_line() {
    for line in [
        "error: private-text",
        "adb: error: private-text",
        "no devices/emulators found",
        "device offline",
        "adb: device serial not found",
    ] {
        output_case(
            "packages",
            support::device(json!({})),
            format!("package:com.failed.example\n{line}\n").as_bytes(),
            b"",
            0,
            ACTION_FAILURE,
        );
    }
}

#[test]
fn uninstall_success_substring_or_failure_with_success_are_not_accepted() {
    for output in [
        b"NotSuccess\n".as_slice(),
        b"Success suffix\n",
        b"Failure [private reason]\nSuccess\n",
    ] {
        output_case(
            "app.uninstall",
            support::device(json!({"package":"com.example.app"})),
            output,
            b"",
            0,
            ACTION_FAILURE,
        );
    }
}

#[test]
fn nonzero_adb_exit_is_fixed_error_without_tool_output_leak() {
    output_case(
        "packages",
        support::device(json!({})),
        b"private stdout",
        b"private stderr",
        9,
        "工具依赖失败：ADB客户端执行失败，请检查部署配置",
    );
}

#[test]
fn input_stdout_and_stderr_diagnostics_each_reject_zero_exit() {
    for (stdout, stderr) in [
        (b"error: private text".as_slice(), b"".as_slice()),
        (b"".as_slice(), b"adb: error: private text".as_slice()),
        (
            b"".as_slice(),
            b"warning is not an empty response".as_slice(),
        ),
    ] {
        output_case(
            "input",
            support::input(json!({"kind":"tap","x":1,"y":2})),
            stdout,
            stderr,
            0,
            INPUT_FAILURE,
        );
    }
}

#[test]
fn input_invalid_utf8_in_either_stream_is_fixed_utf8_failure() {
    for (stdout, stderr) in [(&[0xff][..], b"".as_slice()), (b"".as_slice(), &[0xfe][..])] {
        output_case(
            "input",
            support::input(json!({"kind":"tap","x":1,"y":2})),
            stdout,
            stderr,
            0,
            BAD_UTF8,
        );
    }
}

#[test]
fn input_whitespace_only_two_streams_remains_legal() {
    let fixture = Fixture::new("input-whitespace");
    fixture.plan(1, b" \n\t", b"\r\n ", 0);
    let mut running = fixture.begin("input", support::input(json!({"kind":"tap","x":1,"y":2})));
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    fixture.release(1);
    probe.assert_exited();
    assert_eq!(success(&running.complete())["dispatched"], true);
    fixture.assert_calls(1);
}

#[test]
fn text_failure_stops_remaining_segments_and_enter() {
    let fixture = Fixture::new("text-stop-after-error");
    fixture.plan(1, b"", b"error: private text", 0);
    let mut running = fixture.begin(
        "input",
        support::input(json!({"kind":"text","text":"a%sb","enter":true})),
    );
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    fixture.release(1);
    probe.assert_exited();
    failure(&running.complete(), INPUT_FAILURE);
    fixture.assert_calls(1);
}

#[test]
fn output_limit_is_applied_to_each_stream_not_combined_or_ignored() {
    for stderr in [false, true] {
        let bytes = vec![b'x'; 1024 * 1024 + 1];
        output_case(
            "packages",
            support::device(json!({})),
            if stderr { b"" } else { &bytes },
            if stderr { &bytes } else { b"" },
            0,
            "数据超过插件限额",
        );
    }
}
