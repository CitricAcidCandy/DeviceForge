//! 八短名的独立输出与固定argv；Some空产物上下文是默认真实宿主形状。
use crate::support::{self, ADDRESS, Fixture, PACKAGE, SERIAL, success};
use serde_json::json;
use std::{fs, path::Path};

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[test]
fn discover_returns_public_devices_without_host_wrapper() {
    let fixture = Fixture::new("normal-discover");
    let reply = fixture.run(
        "discover",
        json!({}),
        &[b"List of devices attached\nserial-A device model:Pixel\n"],
    );
    assert_eq!(
        success(&reply),
        &json!([support::expected_device(
            "serial-A",
            "device",
            "online",
            Some("Pixel"),
            None
        )])
    );
    assert_eq!(fixture.argv(1), argv(&["devices", "-l"]));
}

#[test]
fn connect_accepts_explicit_success_with_provider_null() {
    let fixture = Fixture::new("normal-connect");
    let reply = fixture.run(
        "connect",
        support::provider(json!({"address":ADDRESS})),
        &[b" connected to [::1]:5555\n"],
    );
    assert_eq!(
        success(&reply),
        &json!({"output":"connected to [::1]:5555"})
    );
    assert_eq!(fixture.argv(1), argv(&["connect", ADDRESS]));
}

#[test]
fn disconnect_keeps_trimmed_output_and_does_not_discover() {
    let fixture = Fixture::new("normal-disconnect");
    let reply = fixture.run(
        "disconnect",
        support::provider(json!({"address":ADDRESS})),
        &[b"disconnected [::1]:5555\n"],
    );
    assert_eq!(
        success(&reply),
        &json!({"output":"disconnected [::1]:5555"})
    );
    assert_eq!(fixture.argv(1), argv(&["disconnect", ADDRESS]));
}

#[test]
fn packages_preserves_failed_and_error_inside_legal_package_names() {
    let fixture = Fixture::new("normal-packages");
    let reply = fixture.run(
        "packages",
        support::device(json!({})),
        &[b"package:com.failed.example\npackage:com.error.example\n"],
    );
    assert_eq!(
        success(&reply),
        &json!({"output":"package:com.failed.example\npackage:com.error.example"})
    );
    assert_eq!(
        fixture.argv(1),
        argv(&["-s", SERIAL, "shell", "pm", "list", "packages"])
    );
}

#[test]
fn app_start_uses_monkey_fixed_argv_and_keeps_original_serial() {
    let fixture = Fixture::new("normal-start");
    let reply = fixture.run(
        "app.start",
        support::device(json!({"package":PACKAGE})),
        &[b"Events injected: 1\n"],
    );
    assert_eq!(success(&reply), &json!({"output":"Events injected: 1"}));
    assert_eq!(
        fixture.argv(1),
        argv(&[
            "-s",
            SERIAL,
            "shell",
            "monkey",
            "-p",
            PACKAGE,
            "-c",
            "android.intent.category.LAUNCHER",
            "1"
        ])
    );
}

#[test]
fn app_stop_uses_force_stop_and_allows_empty_success() {
    let fixture = Fixture::new("normal-stop");
    let reply = fixture.run(
        "app.stop",
        support::device(json!({"package":PACKAGE})),
        &[b""],
    );
    assert_eq!(success(&reply), &json!({"output":""}));
    assert_eq!(
        fixture.argv(1),
        argv(&["-s", SERIAL, "shell", "am", "force-stop", PACKAGE])
    );
}

#[test]
fn app_uninstall_requires_independent_success_line() {
    let fixture = Fixture::new("normal-uninstall");
    let reply = fixture.run(
        "app.uninstall",
        support::device(json!({"package":PACKAGE})),
        &[b"Uninstall completed\nSuccess\n"],
    );
    assert_eq!(
        success(&reply),
        &json!({"output":"Uninstall completed\nSuccess"})
    );
    assert_eq!(fixture.argv(1), argv(&["-s", SERIAL, "uninstall", PACKAGE]));
}

#[test]
fn tap_coordinates_at_boundaries_have_exact_decimal_argv() {
    let fixture = Fixture::new("normal-tap");
    let reply = fixture.run(
        "input",
        support::input(json!({"kind":"tap","x":0,"y":32767})),
        &[b""],
    );
    assert_eq!(
        success(&reply),
        &json!({"device_id":SERIAL,"action":"tap","dispatched":true})
    );
    assert_eq!(
        fixture.argv(1),
        argv(&["-s", SERIAL, "shell", "-T", "input", "tap", "0", "32767"])
    );
}

#[test]
fn swipe_and_keyevent_keep_fixed_arguments_and_optional_default() {
    for (action, tail, kind) in [
        (
            json!({"kind":"swipe","x1":0,"y1":1,"x2":32767,"y2":2,"duration_ms":10000}),
            vec!["swipe", "0", "1", "32767", "2", "10000"],
            "swipe",
        ),
        (
            json!({"kind":"keyevent","key_code":65535,"long_press":true}),
            vec!["keyevent", "--longpress", "65535"],
            "keyevent",
        ),
        (
            json!({"kind":"keyevent","key_code":1}),
            vec!["keyevent", "1"],
            "keyevent",
        ),
    ] {
        let fixture = Fixture::new("normal-key-swipe");
        let reply = fixture.run("input", support::input(action), &[b""]);
        assert_eq!(
            success(&reply),
            &json!({"device_id":SERIAL,"action":kind,"dispatched":true})
        );
        let mut expected = argv(&["-s", SERIAL, "shell", "-T", "input"]);
        expected.extend(argv(&tail));
        assert_eq!(fixture.argv(1), expected);
    }
}

#[test]
fn text_quotes_literal_percent_s_and_enter_use_three_distinct_calls() {
    let fixture = Fixture::new("normal-text");
    let reply = fixture.run(
        "input",
        support::input(json!({"kind":"text","text":"A B'%sC","enter":true})),
        &[b"", b"", b""],
    );
    assert_eq!(
        success(&reply),
        &json!({"device_id":SERIAL,"action":"text","dispatched":true})
    );
    for (index, tail) in [
        vec!["text", "'A%sB'\\''%'"],
        vec!["text", "'sC'"],
        vec!["keyevent", "66"],
    ]
    .iter()
    .enumerate()
    {
        let mut expected = argv(&["-s", SERIAL, "shell", "-T", "input"]);
        expected.extend(argv(tail));
        assert_eq!(
            fixture.argv(index + 1),
            expected,
            "设备端引用规则须看实际argv"
        );
    }
}

#[test]
fn restricted_tool_environment_excludes_adb_and_service_overrides() {
    let fixture = Fixture::new("restricted-environment");
    assert!(fixture.executable.is_file());
    let reply = fixture.run("packages", support::device(json!({})), &[b""]);
    success(&reply);
    assert_eq!(
        fs::read(fixture.root.join("call-01/restricted-flags.bin")).unwrap(),
        [0, 0, 0, 0]
    );
}

#[test]
fn text_exact_1024_ascii_bytes_has_one_quoted_command() {
    let fixture = Fixture::new("text-limit-equal");
    let text = "A".repeat(1024);
    let reply = fixture.run(
        "input",
        support::input(json!({"kind":"text","text":text})),
        &[b""],
    );
    assert_eq!(
        success(&reply),
        &json!({"device_id":SERIAL,"action":"text","dispatched":true})
    );
    assert_eq!(
        fixture.argv(1).last().unwrap(),
        &format!("'{}'", "A".repeat(1024))
    );
}

#[test]
fn unicode_text_uses_real_pm_path_and_fixed_adb_keyboard_argv() {
    let mut fixture = Fixture::new("normal-unicode-input");
    fixture.config["unicode_input"] = json!({
        "package": "com.android.adbkeyboard",
        "component": "com.android.adbkeyboard/.AdbIME",
        "action": "ADB_INPUT_TEXT",
        "extra": "msg"
    });
    fixture.save_config();
    let reply = fixture.run(
        "input",
        support::input(json!({"kind":"text","text":"中文🙂","enter":true})),
        &[
            b"package:/data/app/~~fixed/com.android.adbkeyboard-abc/base.apk\n",
            b"com.android.adbkeyboard/.AdbIME\n",
            b"com.android.adbkeyboard/.AdbIME\n",
            b"Broadcast completed: result=0\n",
            b"",
        ],
    );
    assert_eq!(
        success(&reply),
        &json!({
            "device_id": SERIAL,
            "action": "text",
            "transport": "adb_keyboard_base64",
            "bytes": 10,
            "dispatched": true
        })
    );
    assert_eq!(
        fixture.argv(1),
        argv(&[
            "-s",
            SERIAL,
            "shell",
            "-T",
            "pm",
            "path",
            "com.android.adbkeyboard"
        ])
    );
    assert_eq!(
        fixture.argv(2),
        argv(&["-s", SERIAL, "shell", "-T", "ime", "list", "-s"])
    );
    assert_eq!(
        fixture.argv(3),
        argv(&[
            "-s",
            SERIAL,
            "shell",
            "-T",
            "settings",
            "get",
            "secure",
            "default_input_method"
        ])
    );
    assert_eq!(
        fixture.argv(4),
        argv(&[
            "-s",
            SERIAL,
            "shell",
            "-T",
            "am",
            "broadcast",
            "-a",
            "ADB_INPUT_TEXT",
            "--es",
            "msg",
            "5Lit5paH8J+Zgg=="
        ])
    );
    assert_eq!(
        fixture.argv(5),
        argv(&["-s", SERIAL, "shell", "-T", "input", "keyevent", "66"])
    );
}

#[test]
fn public_metadata_is_api3_protocol4_with_fourteen_short_names_and_thirteen_capabilities() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let bytes = fs::read(root.join("manifest.json")).unwrap();
    assert_eq!(bytes, fs::read(root.join("manifest.example.json")).unwrap());
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["id"], "android-device");
    assert_eq!(manifest["protocol_version"], 4);
    assert_eq!(manifest["devices"]["api_version"], 3);
    assert_eq!(manifest["devices"]["discover_operation"], "discover");
    let mut names: Vec<_> = manifest["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "app.install",
            "app.install_apks",
            "app.start",
            "app.stop",
            "app.uninstall",
            "connect",
            "disconnect",
            "discover",
            "input",
            "packages",
            "performance.sample",
            "profile.record",
            "screenshot",
            "stack.probe"
        ]
    );
    assert!(
        manifest["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry.get("execution").is_none())
    );
    let capabilities = manifest["devices"]["capabilities"].as_array().unwrap();
    assert_eq!(capabilities.len(), 13);
    for name in names.iter().filter(|name| **name != "discover") {
        let matches: Vec<_> = capabilities
            .iter()
            .filter(|entry| entry["id"] == *name)
            .collect();
        assert_eq!(matches.len(), 1);
        let capability = matches[0];
        assert_eq!(capability["id"], *name);
        assert_eq!(capability["operation"], *name);
        assert_eq!(capability["version"], 1);
        assert_eq!(
            capability["execution_timeout_ms"],
            if *name == "performance.sample" {
                10000
            } else if matches!(
                *name,
                "app.uninstall"
                    | "app.install"
                    | "app.install_apks"
                    | "stack.probe"
                    | "profile.record"
            ) {
                120000
            } else {
                30000
            }
        );
        assert_eq!(
            capability["scope"],
            if matches!(*name, "connect" | "disconnect") {
                "provider"
            } else {
                "device"
            }
        );
        assert_eq!(
            capability["access"],
            if matches!(*name, "packages" | "performance.sample") {
                "read"
            } else {
                "write"
            }
        );
    }
    assert_eq!(
        manifest["artifacts"],
        json!({"input_fields":[],"input_pointers":["/input/artifact_id"],"outputs":true})
    );
    assert_eq!(
        manifest["performance"],
        json!({"api_version":2,"sample_operation":"performance.sample","fps":true,"device_observation":true,"device_capability":{"id":"performance.sample","version":1}})
    );
    let aliases: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("aliases.example.json")).unwrap()).unwrap();
    assert_eq!(aliases["format_version"], 2);
    let bindings = aliases["bindings"].as_array().unwrap();
    assert_eq!(bindings.len(), 11);
    let discovery = bindings
        .iter()
        .find(|binding| binding["operation"]["id"] == "android.devices")
        .unwrap();
    assert_eq!(
        discovery["target"],
        json!({"kind":"device_discovery","plugin_id":"android-device"})
    );
    assert!(
        bindings.iter().all(|binding| {
            !matches!(
                binding["operation"]["id"].as_str(),
                Some(
                    "android.performance.sample" | "android.stack.probe" | "android.profile.record"
                )
            )
        }),
        "采样只通过插件贡献或公开设备动作调用，不添加内置别名"
    );
    for name in names.iter().filter(|name| {
        !matches!(
            **name,
            "discover" | "performance.sample" | "stack.probe" | "profile.record"
        )
    }) {
        let id = format!("android.{name}");
        let matches: Vec<_> = bindings
            .iter()
            .filter(|binding| binding["operation"]["id"] == id)
            .collect();
        assert_eq!(matches.len(), 1);
        let binding = matches[0];
        assert_eq!(binding["operation"]["id"], format!("android.{name}"));
        assert_eq!(binding["input"], "device_envelope");
        assert_eq!(
            binding["target"],
            json!({"kind":"device_capability","plugin_id":"android-device","capability":name,"version":1})
        );
        assert_eq!(
            binding["result"],
            if *name == "screenshot" {
                json!({"kind":"artifact","filename":"screenshot.png"})
            } else {
                json!({"kind":"value","wrapped":true})
            }
        );
    }
    // 静态元数据对照不算真实validator或宿主服务加载通过。
}
