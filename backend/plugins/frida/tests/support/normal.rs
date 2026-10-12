//! 正常业务必须交付实际工具argv、授权副本、初始化证据及固定产物。
use crate::support::{Fixture, success};
use serde_json::json;
use std::{fs, path::Path};

#[tokio::test]
async fn deploy_checks_authorized_copy_then_removes_only_uploaded_file() {
    let fixture = Fixture::new();
    let bytes = b"frida-server-fixture";
    let artifact = fixture.artifact("/input/artifact_id", "server-1", bytes);
    fixture.response(1, b"pushed\n", b"", 0, true);
    fixture.response(2, b"16.7.0\n16.7.0\n", b"", 0, true);
    fixture.response(3, b"", b"", 0, true);
    let response = fixture
        .start(
            "server.deploy",
            json!({"artifact_id":"server-1"}),
            vec![artifact.clone()],
        )
        .await
        .response()
        .await;
    assert_eq!(success(&response)["deployed"], true);
    let args = fixture.argv(1);
    assert_eq!(&args[..3], ["-s", "device-1", "push"]);
    assert_ne!(args[3], artifact["path"].as_str().unwrap());
    assert_eq!(fs::read(fixture.call(1).join("source.bin")).unwrap(), bytes);
    assert!(Path::new(&args[3]).starts_with(&fixture.scratch));
    assert!(args[4].starts_with("/data/local/tmp/deviceforge-frida-upload-"));
    let install = fixture.stdin(2);
    assert!(install.contains("id -u | grep -qx 0"));
    assert!(install.contains("chmod 700"));
    assert!(install.contains("--version"));
    assert!(install.contains(&args[4]));
    let cleanup = fixture.stdin(3);
    assert!(cleanup.contains(&args[4]));
    assert!(!cleanup.contains("deviceforge-frida-server"));
    assert!(!cleanup.contains("kill"));
    fixture.assert_outputs(&response, &["operation.json", "frida.log"]);
    fixture.assert_clean();
}

#[tokio::test]
async fn status_observes_existing_pids_without_claiming_cleanup_rights() {
    let fixture = Fixture::new();
    fixture.response(1, b"installed\n16.7.0\nPID 991\nPID 992\n", b"", 0, true);
    let response = fixture
        .start("server.status", json!({}), vec![])
        .await
        .response()
        .await;
    let result = success(&response);
    assert_eq!(result["pids"], json!([991, 992]));
    assert_eq!(result["ownership"], "observed_only");
    assert_eq!(result["running"], true);
    let input = fixture.stdin(1);
    assert!(input.contains("readlink"));
    assert!(!input.contains("kill"));
    assert!(!fixture.call(2).exists());
    fixture.assert_outputs(&response, &["operation.json", "frida.log"]);
    fixture.assert_clean();
}

#[tokio::test]
async fn process_list_preserves_real_json_pids_and_device_selector() {
    let fixture = Fixture::new();
    fixture.response(
        1,
        r#"[{"pid":123,"name":"中文应用"},{"pid":456,"name":"system_server"}]"#.as_bytes(),
        b"",
        0,
        true,
    );
    let response = fixture
        .start("processes", json!({}), vec![])
        .await
        .response()
        .await;
    assert_eq!(
        success(&response)["processes"][0],
        json!({"pid":123,"name":"中文应用"})
    );
    assert_eq!(fixture.argv(1), ["-D", "device-1", "--json"]);
    fixture.assert_outputs(&response, &["operation.json", "frida.log"]);
    fixture.assert_clean();
}

#[tokio::test]
async fn spawn_script_uses_private_utf8_copy_timeout_and_explicit_notice_prefix() {
    let fixture = Fixture::new();
    let script = "// 授权脚本\nsend({type:'notice',ignored:true});\n".as_bytes();
    let artifact = fixture.artifact("/input/script_artifact_id", "script-1", script);
    fixture.response(1,b"console-message\nsend({type:'notice'})\n__DEVICEFORGE_NOTICE__{\"type\":\"notice\",\"message\":\"observed\"}\n",b"diagnostic\n",0,true);
    let response = fixture.start("script.run",json!({"package":"com.example.app","mode":"spawn","duration_ms":1001,"script_artifact_id":"script-1"}),vec![artifact.clone()]).await.response().await;
    let result = success(&response);
    assert_eq!(result["cli_timeout_seconds"], 2);
    assert_eq!(result["notice_count"], 1);
    assert_eq!(result["resume"], "cli_default");
    assert_eq!(result["target_process_cleanup"], "not_claimed");
    let args = fixture.argv(1);
    assert_eq!(
        &args[..5],
        ["-D", "device-1", "-f", "com.example.app", "-l"]
    );
    assert_eq!(&args[6..], ["-q", "--timeout", "2", "--exit-on-error"]);
    assert_ne!(args[5], artifact["path"].as_str().unwrap());
    assert_eq!(fs::read(fixture.call(1).join("script.js")).unwrap(), script);
    let directory = Path::new(&args[5]).parent().unwrap();
    assert!(directory.starts_with(&fixture.scratch));
    for file in ["cwd", "TEMP", "TMP", "TMPDIR"] {
        assert_eq!(
            Path::new(&fs::read_to_string(fixture.call(1).join(file)).unwrap()),
            directory
        );
    }
    assert_eq!(
        fs::read(fixture.call(1).join("restricted.bin")).unwrap(),
        [0, 0, 0]
    );
    assert_eq!(fs::read(fixture.outputs.join("script.js")).unwrap(), script);
    assert_eq!(
        fs::read_to_string(fixture.outputs.join("notices.jsonl")).unwrap(),
        "{\"type\":\"notice\",\"message\":\"observed\"}\n"
    );
    assert!(!fixture.call(2).exists());
    fixture.assert_outputs(
        &response,
        &["operation.json", "frida.log", "script.js", "notices.jsonl"],
    );
    fixture.assert_clean();
}

#[tokio::test]
async fn permission_attach_generates_selected_hooks_and_requires_summary() {
    let fixture = Fixture::new();
    fixture.response(1,b"__DEVICEFORGE_HOOK__{\"type\":\"installed\",\"class\":\"android.hardware.Camera\"}\n__DEVICEFORGE_HOOK__{\"type\":\"missing\",\"class\":\"vendor.Missing\"}\n__DEVICEFORGE_HOOK__{\"type\":\"summary\",\"installed\":1,\"missing\":1}\n",b"",0,true);
    let response = fixture.start("permissions.analyze",json!({"package":"com.example.app","mode":"attach","duration_ms":100,"modules":["camera"],"show_log":false,
        "hooks":[{"class":"vendor.Missing","method":"observe","module":"custom","action":"观察","messages":"特定值","args":["exact"]}]}),vec![]).await.response().await;
    let result = success(&response);
    assert_eq!(result["resume"], "already_running");
    assert_eq!(result["notice_count"], 0);
    assert_eq!(result["hook_summary"].as_array().unwrap().len(), 3);
    let args = fixture.argv(1);
    assert_eq!(
        &args[..5],
        ["-D", "device-1", "-n", "com.example.app", "-l"]
    );
    let generated = fs::read_to_string(fixture.call(1).join("script.js")).unwrap();
    assert!(generated.contains("\"show_log\":false"));
    assert!(generated.contains("android.hardware.Camera"));
    assert!(generated.contains("vendor.Missing"));
    assert!(generated.contains("\"args\":[\"exact\"]"));
    assert!(!generated.contains("android.telephony.TelephonyManager"));
    assert!(!generated.contains("__DEVICEFORGE_CONFIGURATION__"));
    assert_eq!(
        fs::read(fixture.outputs.join("permissions.js")).unwrap(),
        generated.as_bytes()
    );
    fixture.assert_outputs(
        &response,
        &[
            "operation.json",
            "frida.log",
            "permissions.js",
            "notices.jsonl",
        ],
    );
    fixture.assert_clean();
}
