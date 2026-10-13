use crate::support::{
    CANCELLED, Fixture, PACKAGE, SERIAL, TOTAL_TIMEOUT, device, failure, success,
};
use serde_json::json;
use std::{fs, time::Duration};

#[test]
fn detail_queries_once_and_returns_complete_unknown_non_startable_fields() {
    let expected = json!({
        "name":PACKAGE,
        "versionCode":7,
        "custom":{"text":"failed and [Fail] are JSON data","enabled":true},
        "hapModuleInfos":[{"bundleName":"other.app","mainElementName":"Entry"},null],
        "metadata":[7,"two"]
    });
    for prefix in [String::new(), format!("{PACKAGE}:\r\n")] {
        let fixture = Fixture::new("detail-complete-object");
        let stdout = format!("{prefix}{expected}");
        let reply = fixture.run(
            "app.detail",
            device(json!({"bundle":PACKAGE})),
            stdout.as_bytes(),
            b"",
            0,
        );
        assert_eq!(success(&reply), &expected);
        assert_eq!(
            fixture.argv(),
            ["-t", SERIAL, "shell", "bm", "dump", "-n", PACKAGE]
        );
        fixture.assert_calls(1);
        assert!(!fixture.root.join("unused-output").exists());
    }
    let fixture = Fixture::new("detail-no-modules");
    assert_eq!(
        success(&fixture.run(
            "app.detail",
            device(json!({"bundle":PACKAGE})),
            br#"{"installed":true,"custom":[1,2]}"#,
            b"",
            0,
        )),
        &json!({"installed":true,"custom":[1,2]})
    );
}

#[test]
fn detail_input_rejects_unknown_fields_and_bad_bundle_before_configuration() {
    for input in [
        json!({}),
        json!({"bundle":null}),
        json!({"bundle":7}),
        json!({"bundle":PACKAGE,"ability":"Entry"}),
        json!({"bundle":PACKAGE,"extra":true}),
    ] {
        let fixture = Fixture::new("detail-invalid-input");
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        fixture.reject(
            fixture.request("app.detail", device(input)),
            "输入无效：应用动作业务字段不符合严格格式",
        );
    }
    for bundle in ["app", "com..app", "com.1bad", "com.app;id", "-flag"] {
        let fixture = Fixture::new("detail-invalid-bundle");
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        fixture.reject(
            fixture.request("app.detail", device(json!({"bundle":bundle}))),
            "输入无效：应用包名须为最多200字节的点分ASCII标识",
        );
    }
}

#[test]
fn detail_diagnostic_utf8_exit_and_invalid_json_have_fixed_failures() {
    for (stdout, stderr, code, error) in [
        (
            br#"{"installed":true}"#.as_slice(),
            b"[Fail] private".as_slice(),
            0,
            "工具依赖失败：HDC返回失败诊断",
        ),
        (
            &[0xff][..],
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情输出不是有效UTF-8",
        ),
        (
            b"{}".as_slice(),
            &[0xff][..],
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            b"private".as_slice(),
            b"private".as_slice(),
            7,
            "工具依赖失败：HDC客户端执行失败，请检查部署配置",
        ),
        (
            b"[]".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情JSON根节点无效",
        ),
        (
            br#"{"name":"other.app"}"#.as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情包名与请求不一致",
        ),
        (
            br#"{"unknown":1,"unknown":2}"#.as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情JSON无效或超出限额",
        ),
        (
            b"{} trailing".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情JSON无效或超出限额",
        ),
        (
            b"other.app:\n{}".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：应用详情JSON无效或超出限额",
        ),
    ] {
        let fixture = Fixture::new("detail-fixed-failure");
        failure(
            &fixture.run(
                "app.detail",
                device(json!({"bundle":PACKAGE})),
                stdout,
                stderr,
                code,
            ),
            error,
        );
        fixture.assert_calls(1);
        assert!(!fixture.root.join("unused-output").exists());
    }
}

#[test]
fn running_detail_cancel_eof_and_deadline_confirm_direct_tool_exit() {
    for mode in ["cancel", "eof", "deadline"] {
        let fixture = Fixture::new("detail-control");
        fixture.plan(b"{}", b"", 0);
        let mut running = fixture.begin("app.detail", device(json!({"bundle":PACKAGE})));
        running.start(if mode == "deadline" {
            Duration::from_secs(3)
        } else {
            Duration::from_secs(20)
        });
        let probe = fixture.wait_tool();
        match mode {
            "cancel" => running.cancel("cancelled"),
            "eof" => running.eof(),
            "deadline" => {}
            _ => unreachable!(),
        }
        failure(
            &running.complete(),
            if mode == "deadline" {
                TOTAL_TIMEOUT
            } else {
                CANCELLED
            },
        );
        probe.assert_exited();
        fixture.assert_calls(1);
        assert!(!fixture.root.join("release").exists());
        assert!(!fixture.root.join("unused-output").exists());
    }
}

#[test]
fn detail_stream_limits_and_zero_budget_never_publish_a_partial_object() {
    for stderr_limit in [false, true] {
        let fixture = Fixture::new("detail-stream-limit");
        let oversized = vec![b'x'; 1024 * 1024 + 1];
        let (stdout, stderr) = if stderr_limit {
            (b"{}".as_slice(), oversized.as_slice())
        } else {
            (oversized.as_slice(), b"".as_slice())
        };
        failure(
            &fixture.run(
                "app.detail",
                device(json!({"bundle":PACKAGE})),
                stdout,
                stderr,
                0,
            ),
            "数据超过插件限额",
        );
    }
    let fixture = Fixture::new("detail-zero-budget");
    fs::write(&fixture.config_path, b"invalid configuration").unwrap();
    let mut running = fixture.begin("app.detail", device(json!({"bundle":PACKAGE})));
    running.start(Duration::ZERO);
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_calls(0);
    assert!(!fixture.root.join("unused-output").exists());
}
