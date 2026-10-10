use crate::support::{
    CANCELLED, Fixture, INSTALL_SUCCESS, TOTAL_TIMEOUT, artifacts, device, failure,
};
use serde_json::json;
use std::{fs, thread, time::Duration};

fn hold_install(mode: &str) {
    let mut fixture = Fixture::new("install-running-control");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let request = artifacts::installation(&fixture, b"private HAP bytes during controlled hold");
    fixture.plan(INSTALL_SUCCESS, b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(if mode == "deadline" {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(20)
    });
    let probe = fixture.wait_tool();
    let private = artifacts::sole_directory(&scratch);
    assert!(private.join("input.hap").is_file());
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
    assert!(!fixture.root.join("release").exists());
    assert!(!private.exists());
    artifacts::empty(&scratch);
}

#[test]
fn installation_cancel_and_eof_confirm_direct_hdc_exit_and_private_cleanup() {
    for mode in ["cancel", "eof"] {
        hold_install(mode);
    }
}

#[test]
fn installation_tool_phase_consumes_original_deadline_and_cleans_scratch() {
    hold_install("deadline");
}

#[test]
fn zero_remaining_budget_rejects_before_configuration_copy_or_hdc() {
    for operation in ["packages", "app.install"] {
        let mut fixture = Fixture::new("zero-budget");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let request = if operation == "app.install" {
            artifacts::installation(&fixture, b"HAP bytes")
        } else {
            fixture.request(operation, device(json!({})))
        };
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        let mut running = fixture.begin_request(request);
        running.start(Duration::ZERO);
        failure(&running.complete(), TOTAL_TIMEOUT);
        fixture.assert_calls(0);
        artifacts::empty(&scratch);
    }
}

#[test]
fn delayed_start_does_not_restart_plugin_origin_budget() {
    let mut fixture = Fixture::new("delayed-start");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let request = artifacts::installation(&fixture, b"HAP bytes");
    let mut running = fixture.begin_request(request);
    thread::sleep(Duration::from_millis(500));
    running.start(Duration::from_millis(200));
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_calls(0);
    artifacts::empty(&scratch);
}

#[cfg(windows)]
#[test]
fn locked_private_hap_reports_cleanup_failed_and_retains_owned_directory() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = Fixture::new("cleanup-denied");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let request = artifacts::installation(&fixture, b"HAP bytes");
    fixture.plan(INSTALL_SUCCESS, b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    let private = artifacts::sole_directory(&scratch);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(private.join("input.hap"))
        .unwrap();
    fixture.release();
    let reply = running.complete();
    probe.assert_exited();
    assert_eq!(reply["cleanup"], "failed");
    assert_eq!(reply["response"]["error"], "插件资源清理未确认");
    assert!(reply["response"].get("result").is_none());
    assert!(reply["response"].get("outputs").is_none());
    assert!(private.is_dir());
    assert!(private.join("input.hap").is_file());
    drop(locked);
    thread::sleep(Duration::from_millis(100));
    assert!(private.is_dir());
}
