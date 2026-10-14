//! 取消依据真实直接工具PID退出；远端清理仅检验发送脚本与确认响应边界。
use crate::support::{Fixture, alive, failure, success};
use serde_json::json;
use std::{fs, process::Stdio, time::Duration};
use tokio::process::Command;

fn cleanup_references_pid(script: &str, pid: u32) -> bool {
    let pid = pid.to_string();
    // 按完整PID字段核对；本次私有目录的随机nonce可以合法包含相同数字子串。
    script
        .split(|character: char| character.is_ascii_whitespace() || "\"';()".contains(character))
        .any(|field| {
            field == pid
                || field.strip_prefix("p=") == Some(pid.as_str())
                || field.strip_prefix("pid=") == Some(pid.as_str())
                || field
                    .strip_prefix("/proc/")
                    .is_some_and(|path| path.split('/').next() == Some(pid.as_str()))
        })
}

fn assert_owned_cleanup(fixture: &Fixture, index: usize) {
    assert_eq!(fixture.argv(index), ["-s", "device-1", "shell", "sh"]);
    let script = fixture.stdin(index);
    for expected in [
        "deviceforge-frida-run-",
        "timer.identity",
        "watch.identity",
        "server.identity",
        "read p start exe",
        "shift 19",
        "readlink /proc/$p/exe",
        "kill \"$p\"",
        "kill -9 \"$p\"",
        "echo CLEAN",
    ] {
        assert!(script.contains(expected), "清理资格缺少：{expected}");
    }
    assert!(!script.contains("pkill"));
    assert!(!script.contains("killall"));
    assert!(
        !cleanup_references_pid(&script, 991),
        "不得引用无关进程的精确PID字段"
    );
    assert!(!script.contains("deviceforge-frida-server"));
}

#[test]
fn cleanup_pid_assertion_accepts_nonce_substrings_and_rejects_exact_unowned_fields() {
    for script in [
        "stop '/data/local/tmp/deviceforge-frida-run-10991-1760371991000/server.identity'",
        "p=9910; kill 9910; cat /proc/9910/stat",
        "read p start exe <'/data/local/tmp/deviceforge-frida-run-991/server.identity'",
    ] {
        assert!(!cleanup_references_pid(script, 991));
    }
    for script in [
        "p=991",
        "pid=991",
        "p=\"991\"",
        "kill 991",
        "kill -9 '991'",
        "cat /proc/991/stat",
        "readlink '/proc/991/exe'",
        "echo '991 12345 server'",
    ] {
        assert!(cleanup_references_pid(script, 991));
    }
}

#[tokio::test]
async fn server_run_records_identity_and_confirms_only_invocation_cleanup() {
    let fixture = Fixture::new();
    fixture.response(1, b"OWNED 801 12345\n", b"", 0, true);
    fixture.response(2, b"server output\nCLEAN\n", b"", 0, true);
    let response = fixture
        .start("server.run", json!({"duration_ms":100}), vec![])
        .await
        .response()
        .await;
    let result = success(&response);
    assert_eq!(result["pid"], 801);
    assert_eq!(result["process_start_ticks"], 12345);
    assert_eq!(result["ownership"], "invocation");
    assert_eq!(result["cleanup"], "confirmed");
    let launch = fixture.stdin(1);
    assert!(launch.contains("sleep 3"));
    assert!(launch.contains("record \"$p\""));
    assert!(launch.contains("record \"$timer\""));
    assert!(launch.contains("record \"$watch\""));
    assert_owned_cleanup(&fixture, 2);
    fixture.assert_outputs(&response, &["operation.json", "frida.log"]);
    fixture.assert_clean();
}

#[tokio::test]
async fn cancelling_running_server_sends_scoped_cleanup_and_no_success_artifacts() {
    let fixture = Fixture::new();
    fixture.response(1, b"OWNED 801 12345\n", b"", 0, true);
    fixture.response(2, b"CLEAN\n", b"", 0, false);
    let mut process = fixture
        .start("server.run", json!({"duration_ms":120000}), vec![])
        .await;
    fixture.wait_call(1).await;
    // 先确认launch工具已交付所有权，避免将未启动时的取消误写成运行期清理。
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.call(1).join("normal-exit-code").is_file() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    process.cancel().await;
    fixture.wait_call(2).await;
    assert_owned_cleanup(&fixture, 2);
    fixture.release(2);
    let response = process.response().await;
    failure(&response, "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("取消")
    );
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}

#[tokio::test]
async fn cancellation_terminates_only_its_direct_cli_and_leaves_other_pid_alive() {
    let fixture = Fixture::new();
    fixture.response(1, b"sentinel\n", b"", 0, false);
    fixture.response(2, b"not delivered", b"", 0, false);
    let mut sentinel = Command::new(&fixture.tool)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    fixture.wait_call(1).await;
    let other_pid = fixture.pid(1);
    assert!(alive(other_pid));
    let artifact = fixture.artifact(
        "/input/script_artifact_id",
        "script-1",
        b"console.log('x');",
    );
    let mut process = fixture.start("script.run",json!({"package":"com.example.app","mode":"attach","duration_ms":120000,"script_artifact_id":"script-1"}),vec![artifact]).await;
    fixture.wait_call(2).await;
    let cli_pid = fixture.pid(2);
    assert!(alive(cli_pid));
    assert_ne!(cli_pid, other_pid);
    process.cancel().await;
    let response = process.response().await;
    failure(&response, "complete");
    assert!(!alive(cli_pid), "响应前必须确认本次直接CLI退出");
    assert!(alive(other_pid), "无关工具PID必须存活");
    assert!(!fixture.call(2).join("normal-exit-code").exists());
    assert!(!fixture.call(3).exists());
    fixture.release(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), sentinel.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}

#[tokio::test]
async fn original_deadline_stops_stalled_cli_without_waiting_requested_duration() {
    let fixture = Fixture::new();
    fixture.response(1, b"never delivered", b"", 0, false);
    let artifact = fixture.artifact(
        "/input/script_artifact_id",
        "script-1",
        b"console.log('x');",
    );
    let process = fixture.start_with_budget("script.run",json!({"package":"com.example.app","mode":"spawn","duration_ms":120000,"script_artifact_id":"script-1"}),vec![artifact],Duration::from_secs(1)).await;
    fixture.wait_call(1).await;
    let pid = fixture.pid(1);
    assert!(alive(pid));
    let response = process.response().await;
    failure(&response, "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("期限")
    );
    assert!(!alive(pid));
    assert_eq!(fixture.argv(1)[8], "120");
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}

#[tokio::test]
async fn missing_clean_marker_or_identity_failure_keeps_cleanup_failed_and_private_evidence() {
    for (stdout, code) in [
        (b"log without confirmation\n".as_slice(), 0),
        (b"".as_slice(), 73),
    ] {
        let fixture = Fixture::new();
        fixture.response(1, b"OWNED 801 12345\n", b"", 0, true);
        fixture.response(2, stdout, b"identity not confirmed\n", code, true);
        let response = fixture
            .start("server.run", json!({"duration_ms":100}), vec![])
            .await
            .response()
            .await;
        failure(&response, "failed");
        assert_owned_cleanup(&fixture, 2);
        assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(&fixture.scratch).unwrap().count(),
            1,
            "未确认的本次资源应保留"
        );
    }
}

#[tokio::test]
async fn cancellation_preserves_failed_cleanup_when_remote_identity_cannot_be_confirmed() {
    let fixture = Fixture::new();
    fixture.response(1, b"OWNED 801 12345\n", b"", 0, true);
    fixture.response(2, b"", b"identity changed\n", 73, true);
    let mut process = fixture
        .start("server.run", json!({"duration_ms":120000}), vec![])
        .await;
    fixture.wait_call(1).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.call(1).join("normal-exit-code").is_file() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    process.cancel().await;
    let response = process.response().await;
    failure(&response, "failed");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("取消")
    );
    assert_owned_cleanup(&fixture, 2);
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&fixture.scratch).unwrap().count(), 1);
}

#[tokio::test]
async fn upload_cleanup_failure_is_failed_even_after_successful_deployment() {
    let fixture = Fixture::new();
    let artifact = fixture.artifact("/input/artifact_id", "server-1", b"server-fixture");
    fixture.response(1, b"pushed\n", b"", 0, true);
    fixture.response(2, b"16.7.0\n", b"", 0, true);
    fixture.response(3, b"", b"upload removal denied\n", 1, true);
    let response = fixture
        .start(
            "server.deploy",
            json!({"artifact_id":"server-1"}),
            vec![artifact],
        )
        .await
        .response()
        .await;
    failure(&response, "failed");
    assert!(fixture.stdin(3).contains(&fixture.argv(1)[4]));
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&fixture.scratch).unwrap().count(), 1);
}

#[tokio::test]
async fn missing_server_ownership_marker_still_triggers_scoped_cleanup() {
    let fixture = Fixture::new();
    fixture.response(1, b"server banner without identity\n", b"", 0, true);
    fixture.response(2, b"CLEAN\n", b"", 0, true);
    let response = fixture
        .start("server.run", json!({"duration_ms":100}), vec![])
        .await
        .response()
        .await;
    failure(&response, "complete");
    assert_owned_cleanup(&fixture, 2);
    assert_eq!(fs::read_dir(&fixture.outputs).unwrap().count(), 0);
    fixture.assert_clean();
}
