use crate::support::{CANCELLED, Fixture, TOTAL_TIMEOUT, artifacts, failure};
use serde_json::json;
use std::{fs, thread, time::Duration};

fn hold_artifact(operation: &str, mode: &str) {
    let mut fixture = Fixture::new("artifact-running-control");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let (request, output_root) = if operation == "app.install" {
        (
            artifacts::installation(&fixture, b"private copy survives while ADB is running"),
            None,
        )
    } else {
        let (request, output) = artifacts::screenshot(&fixture);
        (request, Some(output))
    };
    fixture.plan(1, &artifacts::png(45), b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(if mode == "deadline" {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(20)
    });
    let probe = fixture.wait_tool(1);
    probe.assert_running();
    let private = artifacts::sole_directory(&scratch);
    assert!(
        private
            .join(if operation == "app.install" {
                "input.apk"
            } else {
                "screenshot.png"
            })
            .is_file()
    );
    let expected = match mode {
        "cancel" => {
            running.cancel("cancelled");
            CANCELLED
        }
        "eof" => {
            running.eof();
            CANCELLED
        }
        _ => TOTAL_TIMEOUT,
    };
    failure(&running.complete(), expected);
    probe.assert_exited();
    fixture.assert_calls(1);
    assert!(!fixture.root.join("release-1").exists());
    assert!(!private.exists());
    artifacts::empty(&scratch);
    if let Some(output) = output_root {
        artifacts::empty(&output);
    }
}

#[test]
fn installation_cancel_and_eof_confirm_tool_exit_and_private_copy_cleanup() {
    for mode in ["cancel", "eof"] {
        hold_artifact("app.install", mode);
    }
}

#[test]
fn screenshot_cancel_and_eof_confirm_file_capture_exit_and_private_directory_cleanup() {
    for mode in ["cancel", "eof"] {
        hold_artifact("screenshot", mode);
    }
}

#[test]
fn installation_and_screenshot_share_original_deadline_during_tool_capture() {
    for operation in ["app.install", "screenshot"] {
        hold_artifact(operation, "deadline");
    }
}

#[test]
fn expired_and_queued_cancel_artifacts_are_zero_io_before_configuration() {
    for operation in ["app.install", "screenshot"] {
        for cancel in [false, true] {
            let mut fixture = Fixture::new("artifact-zero-budget");
            let scratch = artifacts::configure_scratch(&mut fixture);
            let request = if operation == "app.install" {
                artifacts::installation(&fixture, b"source")
            } else {
                artifacts::screenshot(&fixture).0
            };
            fs::write(&fixture.config_path, b"invalid-configuration").unwrap();
            let mut running = fixture.begin_request(request);
            if cancel {
                running.send_batch(&[
                    running.start_frame(Duration::from_secs(20)),
                    running.cancel_frame("cancelled"),
                ]);
            } else {
                running.start(Duration::ZERO);
            }
            failure(
                &running.complete(),
                if cancel { CANCELLED } else { TOTAL_TIMEOUT },
            );
            fixture.assert_no_tool();
            artifacts::empty(&scratch);
        }
    }
}

#[test]
fn delayed_artifact_start_does_not_reset_origin_deadline() {
    for operation in ["app.install", "screenshot"] {
        let mut fixture = Fixture::new("artifact-delayed-start");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let request = if operation == "app.install" {
            artifacts::installation(&fixture, b"source")
        } else {
            artifacts::screenshot(&fixture).0
        };
        let mut running = fixture.begin_request(request);
        thread::sleep(Duration::from_millis(500));
        running.start(Duration::from_millis(200));
        failure(&running.complete(), TOTAL_TIMEOUT);
        fixture.assert_no_tool();
        artifacts::empty(&scratch);
    }
}

#[cfg(windows)]
#[test]
fn locked_private_install_file_makes_cleanup_failed_and_preserves_directory() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = Fixture::new("artifact-cleanup-denied");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let request = artifacts::installation(&fixture, b"source");
    fixture.plan(1, b"Success\n", b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    let private = artifacts::sole_directory(&scratch);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(private.join("input.apk"))
        .unwrap();
    fixture.release(1);
    let reply = running.complete();
    probe.assert_exited();
    assert_eq!(reply["cleanup"], "failed");
    assert_eq!(reply["response"]["error"], "插件资源清理未确认");
    assert!(reply["response"].get("result").is_none());
    assert!(reply["response"].get("outputs").is_none());
    assert!(private.is_dir());
    assert!(private.join("input.apk").is_file());
    drop(locked);
    fixture.assert_calls(1);
    fs::write(
        fixture.root.join("cleanup-failed-evidence.json"),
        serde_json::to_vec(&json!({
            "private_directory_retained":true,"lock_released_after_reply":true,"external_lock":true
        }))
        .unwrap(),
    )
    .unwrap();
}
