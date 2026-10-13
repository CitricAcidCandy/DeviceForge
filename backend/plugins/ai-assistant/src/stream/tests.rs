use super::*;
use crate::sessions::Lease;
use fs2::FileExt;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs::OpenOptions};

mod client;
use client::{Client, exited, project};

const ID: &str = "12345678-1234-1234-1234-123456789abc";

fn input() -> Value {
    json!({"project_id":"demo","prompt":"原始中文提示词"})
}

fn snapshot(root: &std::path::Path) -> crate::sessions::Snapshot {
    serde_json::from_slice(
        &std::fs::read(root.join("state/threads").join(format!("{ID}.json"))).unwrap(),
    )
    .unwrap()
}

#[test]
fn stream_manifest_keeps_five_tasks_and_adds_one_independent_bounded_session() {
    let manifest: apk_plugin_sdk::Manifest =
        serde_json::from_str(include_str!("../../manifest.json")).unwrap();
    assert_eq!(manifest.protocol_version, 4);
    assert_eq!(manifest.operations.len(), 5);
    assert!(manifest.artifacts.is_none());
    let sessions = manifest.sessions.unwrap();
    sessions.validate().unwrap();
    assert_eq!(sessions.operations.len(), 1);
    assert_eq!(sessions.operations[0].name, "cli.stream");
    assert_eq!(
        sessions.operations[0]
            .execution
            .as_ref()
            .unwrap()
            .total_timeout_ms,
        600000
    );
    assert!(
        !sessions.operations[0].input_schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("executable")
    );
}

#[tokio::test]
async fn real_node_output_precedes_exit_and_eof_preserves_one_prompt_and_thread_lock() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), "gated", 10000000000, input()).await;
    client.control("eof", None).await;
    client.until("item.started").await;
    let pid = std::fs::read_to_string(&client.pid_file)
        .unwrap()
        .parse()
        .unwrap();
    assert!(!exited(pid));
    assert_eq!(
        std::fs::read_to_string(client.pid_file.with_extension("pid.prompt")).unwrap(),
        "原始中文提示词"
    );
    let state = snapshot(root.path());
    assert_eq!(state.turns, 0);
    assert!(state.uncertain);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("state/threads").join(format!("{ID}.lock")))
        .unwrap();
    assert!(lock.try_lock_exclusive().is_err());
    std::fs::write(client.pid_file.with_extension("pid.continue"), b"continue").unwrap();
    let (outcome, events) = client.finished().await;
    assert_eq!(outcome["cleanup"], "complete");
    assert_eq!(outcome["result"]["text"], "中文回答 [已隐藏]");
    assert_eq!(outcome["result"]["turns"], "1");
    assert_eq!(outcome["result"]["resource_scope"], "direct_process");
    assert!(events.iter().any(|event| event["type"] == "turn.completed"));
    assert!(outcome["result"].get("events").is_none());
    let state = snapshot(root.path());
    assert_eq!(state.turns, 1);
    assert!(!state.uncertain);
    lock.try_lock_exclusive().unwrap();
    FileExt::unlock(&lock).unwrap();
}

#[tokio::test]
async fn extra_input_cancels_tool_and_keeps_new_thread_uncertain_without_replay() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), "hang", 10000000000, input()).await;
    client.until("item.started").await;
    client.control("input", Some(vec![1, 2])).await;
    let (outcome, _) = client.finished().await;
    assert_eq!(outcome["cleanup"], "complete");
    assert!(outcome["error"].as_str().unwrap().contains("追加Input"));
    assert!(snapshot(root.path()).uncertain);
    assert_eq!(snapshot(root.path()).turns, 0);
}

#[tokio::test]
async fn public_cancel_reaps_actual_pid_and_uncertain_thread_refuses_a_second_process() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), "hang", 10000000000, input()).await;
    client.until("item.started").await;
    client.control("cancel", None).await;
    let (outcome, _) = client.finished().await;
    assert_eq!(outcome["cleanup"], "complete");
    assert!(outcome["error"].as_str().unwrap().contains("取消"));
    let client = Client::start(
        root.path(),
        "normal",
        10000000000,
        json!({"project_id":"demo","prompt":"不要重放","thread_id":ID}),
    )
    .await;
    let pid = client.pid_file.clone();
    let (outcome, _) = client.finished().await;
    assert!(!pid.exists());
    assert!(outcome["error"].as_str().unwrap().contains("上一轮未确认"));
    assert_eq!(snapshot(root.path()).turns, 0);
}

#[tokio::test]
async fn original_deadline_reaps_actual_pid_and_does_not_commit_a_partial_answer() {
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start(root.path(), "hang", 2000000000, input()).await;
    client.until("item.started").await;
    let (outcome, _) = client.finished().await;
    assert_eq!(outcome["cleanup"], "complete");
    assert!(outcome["error"].as_str().unwrap().contains("期限"));
    assert!(snapshot(root.path()).uncertain);
    assert_eq!(snapshot(root.path()).turns, 0);
}

#[tokio::test]
async fn nonzero_partial_and_late_error_events_never_commit_even_after_provider_completion() {
    for mode in ["nonzero", "partial", "late"] {
        let root = tempfile::tempdir().unwrap();
        let client = Client::start(root.path(), mode, 10000000000, input()).await;
        let (outcome, _) = client.finished().await;
        assert_eq!(outcome["cleanup"], "complete");
        assert!(outcome.get("result").is_none());
        assert!(outcome["error"].is_string());
        assert!(snapshot(root.path()).uncertain);
        assert_eq!(snapshot(root.path()).turns, 0);
    }
}

#[tokio::test]
async fn resume_uses_same_uuid_project_and_lock_then_counts_only_the_completed_turn() {
    let root = tempfile::tempdir().unwrap();
    let client = Client::start(root.path(), "normal", 10000000000, input()).await;
    let (outcome, _) = client.finished().await;
    assert_eq!(outcome["result"]["turns"], "1");
    let client = Client::start(
        root.path(),
        "normal",
        10000000000,
        json!({"project_id":"demo","prompt":"第二轮","thread_id":ID.to_ascii_uppercase()}),
    )
    .await;
    let (outcome, _) = client.finished().await;
    assert_eq!(outcome["cleanup"], "complete");
    assert_eq!(outcome["result"]["turns"], "2");
    assert_eq!(outcome["result"]["thread_id"], ID);
    assert_eq!(snapshot(root.path()).turns, 2);
}

#[tokio::test]
async fn unknown_closed_and_changed_project_directory_fail_before_any_cli_process() {
    for mode in ["unknown", "closed", "moved"] {
        let root = tempfile::tempdir().unwrap();
        let project = project(root.path());
        if mode != "unknown" {
            let stored_project = if mode == "moved" {
                root.path().join("old-project")
            } else {
                project
            };
            let mut lease = Lease::acquire(
                &root.path().join("state"),
                ID,
                "demo",
                &stored_project,
                &|| Ok(()),
            )
            .unwrap();
            lease
                .complete("demo".into(), stored_project, ID.into(), &|| Ok(()))
                .unwrap();
            if mode == "closed" {
                lease.close(&|| Ok(())).unwrap();
            }
        }
        let client = Client::start(
            root.path(),
            "normal",
            10000000000,
            json!({"project_id":"demo","prompt":"不要执行","thread_id":ID}),
        )
        .await;
        let pid = client.pid_file.clone();
        let (outcome, _) = client.finished().await;
        assert_eq!(outcome["cleanup"], "complete");
        assert!(outcome["error"].is_string());
        assert!(!pid.exists());
    }
}
