//! 拒绝路径不得触发工具，业务失败不得交付伪成功产物。
use crate::support::{Fixture, failure};
use serde_json::json;
use std::fs;

#[tokio::test]
async fn mismatched_artifact_digest_and_authorization_are_rejected_before_tools() {
    for bad_field in [false, true] {
        let fixture = Fixture::new();
        let mut artifact = fixture.artifact("/input/artifact_id", "server-1", b"server");
        if bad_field {
            artifact["field"] = json!("/input/script_artifact_id");
        } else {
            artifact["sha256"] = json!("0".repeat(64));
        }
        let response = fixture
            .start(
                "server.deploy",
                json!({"artifact_id":"server-1"}),
                vec![artifact],
            )
            .await
            .response()
            .await;
        failure(&response, "complete");
        assert!(!fixture.call(1).exists());
        assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
        fixture.assert_clean();
    }
}

#[tokio::test]
async fn browser_cannot_override_tool_path_or_inject_command_arguments() {
    for input in [
        json!({"duration_ms":100,"program":"untrusted"}),
        json!({"duration_ms":100,"args":["shell","reboot"]}),
    ] {
        let fixture = Fixture::new();
        let response = fixture
            .start("server.run", input, vec![])
            .await
            .response()
            .await;
        failure(&response, "complete");
        assert!(!fixture.call(1).exists());
        fixture.assert_clean();
    }
}

#[tokio::test]
async fn missing_permission_initialization_summary_is_failure_even_when_cli_exits_zero() {
    let fixture = Fixture::new();
    fixture.response(
        1,
        b"ordinary console line\n__DEVICEFORGE_HOOK__{\"type\":\"missing\"}\n",
        b"",
        0,
        true,
    );
    let response = fixture.start("permissions.analyze",json!({"package":"com.example.app","mode":"spawn","duration_ms":100,"modules":["camera"]}),vec![]).await.response().await;
    failure(&response, "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("初始化统计")
    );
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}

#[tokio::test]
async fn cli_error_and_malformed_notice_do_not_publish_outputs() {
    for (output, code) in [
        (b"tool failure\n".as_slice(), 7),
        (b"__DEVICEFORGE_NOTICE__not-json\n".as_slice(), 0),
    ] {
        let fixture = Fixture::new();
        let artifact = fixture.artifact(
            "/input/script_artifact_id",
            "script-1",
            b"console.log('x');",
        );
        fixture.response(1, output, b"controlled failure\n", code, true);
        let response = fixture.start("script.run",json!({"package":"com.example.app","mode":"attach","duration_ms":100,"script_artifact_id":"script-1"}),vec![artifact]).await.response().await;
        failure(&response, "complete");
        assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
        fixture.assert_clean();
    }
}

#[tokio::test]
async fn invalid_process_pid_and_status_marker_are_not_guessed() {
    for (operation, bytes) in [
        (
            "processes",
            b"[{\"pid\":0,\"name\":\"invalid\"}]".as_slice(),
        ),
        ("server.status", b"16.7.0\nPID 123\n".as_slice()),
    ] {
        let fixture = Fixture::new();
        fixture.response(1, bytes, b"", 0, true);
        let response = fixture
            .start(operation, json!({}), vec![])
            .await
            .response()
            .await;
        failure(&response, "complete");
        assert!(!fixture.call(2).exists());
        assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
        fixture.assert_clean();
    }
}

#[tokio::test]
async fn deploy_failure_still_cleans_upload_and_keeps_original_authorized_file() {
    let fixture = Fixture::new();
    let artifact = fixture.artifact("/input/artifact_id", "server-1", b"server-fixture");
    fixture.response(1, b"pushed\n", b"", 0, true);
    fixture.response(2, b"", b"root denied\n", 1, true);
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
    failure(&response, "complete");
    let staged = fixture.argv(1)[4].clone();
    assert!(fixture.stdin(3).contains(&staged));
    assert!(!fixture.stdin(3).contains("deviceforge-frida-server"));
    assert_eq!(
        fs::read(artifact["path"].as_str().unwrap()).unwrap(),
        b"server-fixture"
    );
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}

#[tokio::test]
async fn existing_output_file_is_preserved_and_only_new_output_is_rolled_back() {
    let fixture = Fixture::new();
    fs::write(fixture.outputs.join("frida.log"), b"existing-user-file").unwrap();
    fixture.response(1, b"[]", b"", 0, true);
    let response = fixture
        .start("processes", json!({}), vec![])
        .await
        .response()
        .await;
    failure(&response, "complete");
    assert!(!fixture.outputs.join("operation.json").exists());
    assert_eq!(
        fs::read(fixture.outputs.join("frida.log")).unwrap(),
        b"existing-user-file"
    );
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 1);
    fixture.assert_clean();
}

#[tokio::test]
async fn invalid_utf8_or_nul_script_is_rejected_without_running_cli() {
    for bytes in [b"console.log('x');\0".as_slice(), b"\xff\xfe".as_slice()] {
        let fixture = Fixture::new();
        let artifact = fixture.artifact("/input/script_artifact_id", "script-1", bytes);
        let response = fixture.start("script.run",json!({"package":"com.example.app","mode":"spawn","duration_ms":100,"script_artifact_id":"script-1"}),vec![artifact]).await.response().await;
        failure(&response, "complete");
        assert!(!fixture.call(1).exists());
        assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
        fixture.assert_clean();
    }
}
