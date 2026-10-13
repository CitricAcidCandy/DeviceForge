use crate::support::{
    CANCELLED, Fixture, PACKAGE, SERIAL, TOTAL_TIMEOUT, device, failure, success,
};
use serde_json::{Value, json};
use std::{
    fs, thread,
    time::{Duration, Instant},
};

const START_SUCCESS: &[u8] = b"start ability successfully\n";
const STOP_SUCCESS: &[u8] = b"force stop process successfully.\n";
const RESET_SUCCESS: &[u8] = b"clean bundle data files successfully.\n";

fn business(operation: &str) -> Value {
    if operation == "app.start" {
        json!({"bundle":PACKAGE,"ability":"EntryAbility"})
    } else {
        json!({"bundle":PACKAGE})
    }
}

fn expected(operation: &str) -> &'static [u8] {
    match operation {
        "app.start" => START_SUCCESS,
        "app.stop" => STOP_SUCCESS,
        "app.reset" => RESET_SUCCESS,
        _ => panic!("独立测试未知动作"),
    }
}

#[test]
fn explicit_start_stop_and_reset_have_fixed_argv_and_no_artifacts() {
    for (operation, args) in [
        (
            "app.start",
            vec![
                "-t",
                SERIAL,
                "shell",
                "aa",
                "start",
                "-a",
                "EntryAbility",
                "-b",
                PACKAGE,
            ],
        ),
        (
            "app.stop",
            vec!["-t", SERIAL, "shell", "aa", "force-stop", PACKAGE],
        ),
        (
            "app.reset",
            vec!["-t", SERIAL, "shell", "bm", "clean", "-d", "-n", PACKAGE],
        ),
    ] {
        let fixture = Fixture::new("application-explicit");
        let stdout = expected(operation);
        let reply = fixture.run(operation, device(business(operation)), stdout, b"", 0);
        assert_eq!(fixture.argv(), args);
        assert_eq!(
            success(&reply),
            &json!({"output":std::str::from_utf8(stdout).unwrap().trim()})
        );
        assert!(!fixture.root.join("unused-output").exists());
        assert!(!fixture.root.join("call-02").exists());
    }
}

#[test]
fn application_validation_rejects_before_configuration_and_any_tool() {
    for operation in ["app.start", "app.stop", "app.reset"] {
        for bundle in ["app", "com..app", "com.1bad", "com.app;id", "-flag"] {
            let fixture = Fixture::new("application-bad-bundle");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            fixture.reject(
                fixture.request(operation, device(json!({"bundle":bundle}))),
                "输入无效：应用包名须为最多200字节的点分ASCII标识",
            );
        }
        let fixture = Fixture::new("application-extra-field");
        fixture.reject(
            fixture.request(operation, device(json!({"bundle":PACKAGE,"extra":true}))),
            "输入无效：应用动作业务字段不符合严格格式",
        );
    }
    for ability in ["", "-flag", "Entry Ability", "Entry;id", "Entry\n", "A..B"] {
        let fixture = Fixture::new("application-bad-ability");
        fixture.reject(
            fixture.request(
                "app.start",
                device(json!({"bundle":PACKAGE,"ability":ability})),
            ),
            "输入无效：Ability名称须为最多200字节的ASCII标识",
        );
    }
    let fixture = Fixture::new("application-null-ability");
    fixture.reject(
        fixture.request(
            "app.start",
            device(json!({"bundle":PACKAGE,"ability":null})),
        ),
        "输入无效：Ability字段必须为字符串",
    );
}

#[test]
fn automatic_start_queries_then_uses_first_module_without_guessing_other_entries() {
    for title in ["", "legacy-title"] {
        let fixture = Fixture::new("application-auto-ability");
        let detail = json!({"name":PACKAGE,"hapModuleInfos":[
            {"bundleName":PACKAGE,"mainAbility":"EntryAbility"},
            {"mainAbility":"OtherAbility"}
        ]});
        let prefix = if title.is_empty() {
            String::new()
        } else {
            format!("{PACKAGE}:\r\n")
        };
        fixture.plan_call(1, format!("{prefix}{detail}").as_bytes(), b"", 0);
        fixture.plan_call(2, START_SUCCESS, b"", 0);
        let mut running = fixture.begin("app.start", device(json!({"bundle":PACKAGE})));
        running.start(Duration::from_secs(20));
        let query = fixture.wait_tool_at(1);
        assert_eq!(
            fixture.argv_at(1),
            ["-t", SERIAL, "shell", "bm", "dump", "-n", PACKAGE]
        );
        assert!(!fixture.root.join("call-02").exists());
        fixture.release_call(1);
        let launch = fixture.wait_tool_at(2);
        query.assert_exited();
        assert_eq!(
            fixture.argv_at(2),
            [
                "-t",
                SERIAL,
                "shell",
                "aa",
                "start",
                "-a",
                "EntryAbility",
                "-b",
                PACKAGE
            ]
        );
        fixture.release_call(2);
        assert_eq!(
            success(&running.complete()),
            &json!({"output":"start ability successfully"})
        );
        launch.assert_exited();
        fixture.assert_calls(2);
        assert!(!fixture.root.join("unused-output").exists());
    }
}

#[test]
fn automatic_start_detail_failure_never_starts_second_command() {
    for (body, expected) in [
        (
            json!({"hapModuleInfos":[]}).to_string(),
            "工具依赖失败：应用详情首模块无效",
        ),
        (
            json!({"hapModuleInfos":[{}]}).to_string(),
            "工具依赖失败：应用详情首模块缺少mainAbility",
        ),
        (
            json!({"hapModuleInfos":[{"mainAbility":"bad ability"}]}).to_string(),
            "工具依赖失败：应用详情首模块mainAbility无效",
        ),
        (
            json!({"name":"other.app","hapModuleInfos":[{"mainAbility":"EntryAbility"}]})
                .to_string(),
            "工具依赖失败：应用详情包名与请求不一致",
        ),
        (
            "private invalid output".into(),
            "工具依赖失败：应用详情JSON无效或超出限额",
        ),
        (
            r#"{"hapModuleInfos":[{"mainAbility":"EntryAbility","mainAbility":"Other"}]}"#.into(),
            "工具依赖失败：应用详情JSON无效或超出限额",
        ),
    ] {
        let fixture = Fixture::new("application-auto-invalid");
        failure(
            &fixture.run(
                "app.start",
                device(json!({"bundle":PACKAGE})),
                body.as_bytes(),
                b"",
                0,
            ),
            expected,
        );
        fixture.assert_calls(1);
        assert!(!fixture.root.join("call-02").exists());
    }
}

#[test]
fn application_success_requires_the_complete_own_line_and_failure_wins() {
    for operation in ["app.start", "app.stop", "app.reset"] {
        let success_text = std::str::from_utf8(expected(operation)).unwrap().trim();
        for stdout in [
            format!("prefix {success_text}\n"),
            format!("{success_text} suffix\n"),
            "Success\n".into(),
            "msg:install bundle successfully.\n".into(),
        ] {
            let fixture = Fixture::new("application-no-success");
            failure(
                &fixture.run(
                    operation,
                    device(business(operation)),
                    stdout.as_bytes(),
                    b"",
                    0,
                ),
                "工具依赖失败：HDC未返回明确成功结果",
            );
        }
        for (stdout, stderr) in [
            (format!("{success_text}\nerror: private"), String::new()),
            (success_text.to_owned(), "failed: private".into()),
        ] {
            let fixture = Fixture::new("application-failure-wins");
            failure(
                &fixture.run(
                    operation,
                    device(business(operation)),
                    stdout.as_bytes(),
                    stderr.as_bytes(),
                    0,
                ),
                "工具依赖失败：HDC返回失败诊断",
            );
        }
    }
}

#[test]
fn exact_hdc_fail_tag_in_either_stream_overrides_every_application_success() {
    for operation in ["app.start", "app.stop", "app.reset"] {
        let success_text = std::str::from_utf8(expected(operation)).unwrap().trim();
        for (stdout, stderr) in [
            (
                format!("{success_text}\n[Fail] independent diagnostic"),
                String::new(),
            ),
            (
                success_text.to_owned(),
                "[fAiL] independent diagnostic".to_owned(),
            ),
        ] {
            let fixture = Fixture::new("application-hdc-fail-tag");
            failure(
                &fixture.run(
                    operation,
                    device(business(operation)),
                    stdout.as_bytes(),
                    stderr.as_bytes(),
                    0,
                ),
                "工具依赖失败：HDC返回失败诊断",
            );
            fixture.assert_calls(1);
            assert!(!fixture.root.join("unused-output").exists());
        }
    }
}

#[test]
fn exact_hdc_fail_tag_in_detail_stderr_never_launches_second_command() {
    let fixture = Fixture::new("application-detail-hdc-fail-tag");
    failure(
        &fixture.run(
            "app.start",
            device(json!({"bundle":PACKAGE})),
            br#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
            b"[Fail] independent detail diagnostic",
            0,
        ),
        "工具依赖失败：HDC返回失败诊断",
    );
    fixture.assert_calls(1);
    assert!(!fixture.root.join("call-02").exists());
    assert!(!fixture.root.join("unused-output").exists());
}

#[test]
fn application_nonzero_exit_utf8_and_stream_limits_have_fixed_errors() {
    for (stdout, stderr, code, error) in [
        (
            START_SUCCESS,
            b"private error".as_slice(),
            7,
            "工具依赖失败：HDC客户端执行失败，请检查部署配置",
        ),
        (
            &[0xff][..],
            b"".as_slice(),
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            START_SUCCESS,
            &[0xff][..],
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
    ] {
        let fixture = Fixture::new("application-capture-failure");
        failure(
            &fixture.run(
                "app.start",
                device(business("app.start")),
                stdout,
                stderr,
                code,
            ),
            error,
        );
    }
    for operation in ["app.start", "app.stop", "app.reset"] {
        let fixture = Fixture::new("application-output-limit");
        let bytes = vec![b'x'; 1024 * 1024 + 1];
        failure(
            &fixture.run(operation, device(business(operation)), &bytes, b"", 0),
            "数据超过插件限额",
        );
    }
}

#[test]
fn each_running_application_action_cancels_and_confirms_direct_tool_exit() {
    for operation in ["app.start", "app.stop", "app.reset"] {
        let fixture = Fixture::new("application-cancel");
        fixture.plan(expected(operation), b"", 0);
        let mut running = fixture.begin(operation, device(business(operation)));
        running.start(Duration::from_secs(20));
        let probe = fixture.wait_tool();
        running.cancel("cancelled");
        failure(&running.complete(), CANCELLED);
        probe.assert_exited();
        fixture.assert_calls(1);
        assert!(!fixture.root.join("unused-output").exists());
    }
}

#[test]
fn automatic_start_cancel_and_deadline_in_query_never_launch() {
    for deadline in [false, true] {
        let fixture = Fixture::new("application-query-control");
        fixture.plan(
            br#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
            b"",
            0,
        );
        let mut running = fixture.begin("app.start", device(json!({"bundle":PACKAGE})));
        running.start(if deadline {
            Duration::from_secs(3)
        } else {
            Duration::from_secs(20)
        });
        let query = fixture.wait_tool();
        if !deadline {
            running.cancel("cancelled");
        }
        failure(
            &running.complete(),
            if deadline { TOTAL_TIMEOUT } else { CANCELLED },
        );
        query.assert_exited();
        fixture.assert_calls(1);
        assert!(!fixture.root.join("call-02").exists());
        assert!(!fixture.root.join("release").exists());
    }
}

#[test]
fn automatic_start_launch_consumes_original_total_deadline() {
    let fixture = Fixture::new("application-launch-deadline");
    fixture.plan_call(
        1,
        br#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
        b"",
        0,
    );
    fixture.plan_call(2, START_SUCCESS, b"", 0);
    let mut running = fixture.begin("app.start", device(json!({"bundle":PACKAGE})));
    let origin = Instant::now();
    running.start(Duration::from_secs(6));
    let query = fixture.wait_tool_at(1);
    thread::sleep(Duration::from_secs(3));
    fixture.release_call(1);
    let launch = fixture.wait_tool_at(2);
    query.assert_exited();
    failure(&running.complete(), TOTAL_TIMEOUT);
    assert!(
        origin.elapsed() < Duration::from_secs(8),
        "第二命令不得重新获得六秒预算"
    );
    launch.assert_exited();
    fixture.assert_calls(2);
    assert!(!fixture.root.join("plan-02/release").exists());
}

#[test]
fn zero_budget_for_every_application_action_has_zero_configuration_or_tool_calls() {
    for operation in ["app.start", "app.stop", "app.reset"] {
        let fixture = Fixture::new("application-zero-budget");
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        let mut running = fixture.begin(operation, device(business(operation)));
        running.start(Duration::ZERO);
        failure(&running.complete(), TOTAL_TIMEOUT);
        fixture.assert_calls(0);
        assert!(!fixture.root.join("unused-output").exists());
    }
}
