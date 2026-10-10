//! 严格业务输入、固定命令与输出资格；不借用包插件或真实进程验收。
use super::*;

fn command(operation: &str, value: Value) -> commands::Command {
    commands::plan(&parse(operation, &value).unwrap()).unwrap()
}

#[test]
fn all_eight_short_names_accept_their_exact_envelopes() {
    let inputs = [
        ("discover", json!({})),
        (
            "connect",
            json!({"device_id":null,"input":{"address":"localhost:5555"}}),
        ),
        (
            "disconnect",
            json!({"device_id":null,"input":{"address":"[::1]:5555"}}),
        ),
        ("packages", json!({"device_id":"设备:一","input":{}})),
        (
            "app.start",
            json!({"device_id":"device","input":{"package":"com.example"}}),
        ),
        (
            "app.stop",
            json!({"device_id":"device","input":{"package":"com.example"}}),
        ),
        (
            "app.uninstall",
            json!({"device_id":"device","input":{"package":"com.example"}}),
        ),
        (
            "input",
            json!({"device_id":"device","input":{"action":{"kind":"tap","x":0,"y":0}}}),
        ),
    ];
    for (name, value) in inputs {
        assert!(parse(name, &value).is_ok(), "{name}");
        assert!(matches!(
            parse(&format!("plugin.android-device.{name}"), &value),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn envelopes_require_explicit_fields_correct_scope_and_strict_objects() {
    for (name, value) in [
        ("discover", json!([])),
        ("discover", json!(null)),
        ("discover", json!({"extra":true})),
        ("connect", json!({"input":{"address":"host:1"}})),
        ("connect", json!({"device_id":null})),
        (
            "connect",
            json!({"device_id":"device","input":{"address":"host:1"}}),
        ),
        (
            "connect",
            json!({"device_id":null,"input":{"address":"host:1"},"timeout_ms":1}),
        ),
        (
            "connect",
            json!({"device_id":null,"input":{"address":"host:1","config":"local"}}),
        ),
        ("packages", json!({"device_id":null,"input":{}})),
        ("packages", json!({"device_id":5,"input":{}})),
        ("packages", json!({"device_id":"device","input":[]})),
        (
            "packages",
            json!({"device_id":"device","input":{"extra":true}}),
        ),
        (
            "app.start",
            json!({"device_id":"device","input":{"package":"com.example","args":[]}}),
        ),
        (
            "input",
            json!({"device_id":"device","input":{"action":{"kind":"tap","x":1,"y":1,"extra":true}}}),
        ),
    ] {
        assert!(
            matches!(parse(name, &value), Err(Error::Invalid(_))),
            "{name}: {value}"
        );
    }
}

#[test]
fn command_arguments_preserve_original_serial_and_only_connect_has_a_short_point() {
    let connect = command(
        "connect",
        json!({"device_id":null,"input":{"address":"host:5555"}}),
    );
    assert_eq!(connect.args, ["connect", "host:5555"]);
    assert_eq!(
        connect.short_limit,
        Some(std::time::Duration::from_millis(5000))
    );
    let device = " 原文 设备 ";
    for (name, input, expected) in [
        (
            "disconnect",
            json!({"device_id":null,"input":{"address":"host:5555"}}),
            vec!["disconnect", "host:5555"],
        ),
        (
            "packages",
            json!({"device_id":device,"input":{}}),
            vec!["-s", device, "shell", "pm", "list", "packages"],
        ),
        (
            "app.start",
            json!({"device_id":device,"input":{"package":"com.example"}}),
            vec![
                "-s",
                device,
                "shell",
                "monkey",
                "-p",
                "com.example",
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ],
        ),
        (
            "app.stop",
            json!({"device_id":device,"input":{"package":"com.example"}}),
            vec!["-s", device, "shell", "am", "force-stop", "com.example"],
        ),
        (
            "app.uninstall",
            json!({"device_id":device,"input":{"package":"com.example"}}),
            vec!["-s", device, "uninstall", "com.example"],
        ),
    ] {
        let command = command(name, input);
        assert_eq!(command.args, expected, "{name}");
        assert!(command.short_limit.is_none());
    }
}

#[test]
fn connect_requires_explicit_success_and_rejects_old_failure_diagnostics() {
    let command = command(
        "connect",
        json!({"device_id":null,"input":{"address":"host:5555"}}),
    );
    for text in [
        " connected to host:5555\r\n",
        "already connected to host:5555",
    ] {
        assert_eq!(command.result(text).unwrap(), json!({"output":text.trim()}));
    }
    for text in [
        "",
        "OK",
        "cannot connect to host:5555",
        "connected to host:5555\nerror: failure",
        "failed to connect",
        "connected to host:5555\nno devices",
    ] {
        assert!(matches!(command.result(text), Err(Error::Dependency(_))));
    }
}

#[test]
fn packages_keep_failure_words_in_names_but_reject_exact_diagnostics() {
    let command = command("packages", json!({"device_id":"device","input":{}}));
    let text = "package:com.failed.example\npackage:com.error.example\n";
    assert_eq!(command.result(text).unwrap(), json!({"output":text.trim()}));
    for text in [
        "error: device offline",
        "package:com.example\nadb: device 'x' not found",
        "no devices/emulators found",
    ] {
        assert!(matches!(command.result(text), Err(Error::Dependency(_))));
    }
}

#[test]
fn uninstall_requires_an_independent_success_line_and_no_failure() {
    let command = command(
        "app.uninstall",
        json!({"device_id":"device","input":{"package":"com.example"}}),
    );
    assert_eq!(
        command.result(" \r\n Success \r\n").unwrap(),
        json!({"output":"Success"})
    );
    for text in [
        "",
        "Success-ish",
        "prefix Success",
        "success",
        "Success\nFailure [reason]",
        "Success\ndevice offline",
    ] {
        assert!(matches!(command.result(text), Err(Error::Dependency(_))));
    }
}

#[test]
fn start_stop_and_disconnect_retain_finite_diagnostic_rejections() {
    for (name, input) in [
        (
            "disconnect",
            json!({"device_id":null,"input":{"address":"host:1"}}),
        ),
        (
            "app.start",
            json!({"device_id":"device","input":{"package":"com.example"}}),
        ),
        (
            "app.stop",
            json!({"device_id":"device","input":{"package":"com.example"}}),
        ),
    ] {
        let command = command(name, input);
        assert!(command.result("\n").is_ok());
        for text in [
            "unable to perform",
            "error: failed",
            "device offline",
            "monkey aborted",
            "no activities found",
        ] {
            assert!(matches!(command.result(text), Err(Error::Dependency(_))));
        }
    }
}

#[test]
fn invalid_utf8_is_a_fixed_dependency_failure_without_output_leakage() {
    let error = text(&[0xff]).unwrap_err();
    assert!(matches!(error, Error::Dependency(_)));
    assert_eq!(error.to_string(), "工具依赖失败：ADB输出不是有效UTF-8文本");
}
