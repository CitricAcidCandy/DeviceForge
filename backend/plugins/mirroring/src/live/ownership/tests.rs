use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn state() -> State {
    let mut state = State::empty();
    state.register("alice", true, false).unwrap();
    state.register("bob", true, false).unwrap();
    state.register("master", true, true).unwrap();
    state.register("viewer", false, true).unwrap();
    state
}

#[test]
fn first_read_only_view_has_valid_positive_control_generation() {
    let mut state = State::empty();
    state.register("viewer", false, false).unwrap();
    let view = state.view("viewer");
    assert!(view.control_revision > 0);
    assert!(view.revision > 0);
    assert!(!view.has_control);
    assert!(view.owner_id.is_none());
}

#[test]
fn first_controller_owns_and_viewers_never_control() {
    let mut state = state();
    assert!(state.is_owner("alice"));
    assert!(!state.is_owner("bob"));
    assert!(state.command("viewer", Command::Request).is_err());
    assert!(state.command("viewer", Command::Reclaim).is_err());
    assert!(!state.view("viewer").can_control);
    assert!(state.view("viewer").is_master);
}

#[test]
fn ordinary_request_waits_for_owner_approval_and_release_confirmation() {
    let mut state = state();
    state.command("bob", Command::Request).unwrap();
    assert_eq!(state.requests, ["bob"]);
    assert!(
        state
            .command(
                "bob",
                Command::Respond {
                    client_id: "bob".into(),
                    accept: true
                }
            )
            .is_err()
    );
    state
        .command(
            "alice",
            Command::Respond {
                client_id: "bob".into(),
                accept: true,
            },
        )
        .unwrap();
    assert!(state.transitioning);
    assert!(!state.is_owner("alice"));
    assert!(!state.is_owner("bob"));
    assert!(state.finish_handoff("bob").is_err());
    state.finish_handoff("alice").unwrap();
    assert!(state.is_owner("bob"));
}

#[test]
fn refusal_does_not_transfer_and_non_requests_cannot_be_approved() {
    let mut state = state();
    assert!(
        state
            .command(
                "alice",
                Command::Respond {
                    client_id: "bob".into(),
                    accept: true
                }
            )
            .is_err()
    );
    state.command("bob", Command::Request).unwrap();
    state
        .command(
            "alice",
            Command::Respond {
                client_id: "bob".into(),
                accept: false,
            },
        )
        .unwrap();
    assert!(state.is_owner("alice"));
    assert!(state.requests.is_empty());
}

#[test]
fn master_reclaim_still_waits_for_old_controller_to_release() {
    let mut state = state();
    assert!(state.command("bob", Command::Reclaim).is_err());
    state.command("master", Command::Reclaim).unwrap();
    assert!(!state.is_owner("master"));
    assert!(!state.is_owner("alice"));
    state.finish_handoff("alice").unwrap();
    assert!(state.is_owner("master"));
}

#[test]
fn master_can_replace_pending_transfer_target() {
    let mut state = state();
    state.command("bob", Command::Request).unwrap();
    state
        .command(
            "alice",
            Command::Respond {
                client_id: "bob".into(),
                accept: true,
            },
        )
        .unwrap();
    state.command("master", Command::Reclaim).unwrap();
    state.finish_handoff("alice").unwrap();
    assert!(state.is_owner("master"));
    assert!(!state.is_owner("bob"));
}

#[test]
fn release_has_no_implicit_approved_successor() {
    let mut state = state();
    state.command("bob", Command::Request).unwrap();
    state.command("alice", Command::Release).unwrap();
    state.finish_handoff("alice").unwrap();
    assert!(state.owner_id.is_none());
    state.command("bob", Command::Request).unwrap();
    assert!(state.is_owner("bob"));
}

#[test]
fn missing_owner_blocks_until_master_confirms_device_recovery() {
    let mut state = state();
    state.prune(&["alice".into()]).unwrap();
    assert!(state.blocked);
    assert!(state.command("bob", Command::Request).is_err());
    state.command("master", Command::Reclaim).unwrap();
    assert!(state.blocked);
    assert!(!state.is_owner("master"));
    assert!(state.finish_recovery("bob").is_err());
    state.finish_recovery("master").unwrap();
    assert!(state.is_owner("master"));
}

#[test]
fn confirmed_unregister_completes_transfer_and_unclean_unregister_blocks() {
    let mut state = state();
    state.command("master", Command::Reclaim).unwrap();
    state.unregister("alice", true).unwrap();
    assert!(state.is_owner("master"));
    state.unregister("master", false).unwrap();
    assert!(state.blocked);
    assert!(!state.is_owner("bob"));
}

#[test]
fn departing_requester_is_removed_and_dead_target_cannot_receive_control() {
    let mut state = state();
    state.command("bob", Command::Request).unwrap();
    state.unregister("bob", true).unwrap();
    assert!(state.requests.is_empty());
    state.command("master", Command::Reclaim).unwrap();
    state.prune(&["master".into()]).unwrap();
    state.finish_handoff("alice").unwrap();
    assert!(state.owner_id.is_none());
}

#[test]
fn participant_request_and_revision_limits_are_enforced() {
    let mut state = State::empty();
    for index in 0..64 {
        state
            .register(&format!("client-{index}"), true, false)
            .unwrap();
    }
    assert!(state.register("overflow", true, false).is_err());
    for index in 1..=32 {
        state
            .command(&format!("client-{index}"), Command::Request)
            .unwrap();
    }
    assert!(state.command("client-33", Command::Request).is_err());
    state.revision = state::SAFE_INTEGER;
    assert!(state.changed().is_err());
}

#[test]
fn duplicate_request_is_idempotent_and_view_keeps_wire_contract() {
    let mut state = state();
    state.command("bob", Command::Request).unwrap();
    let revision = state.revision;
    state.command("bob", Command::Request).unwrap();
    assert_eq!(state.revision, revision);
    let value = serde_json::to_value(state.view("bob")).unwrap();
    assert_eq!(value["type"], "control_state");
    assert_eq!(value["version"], 1);
    assert_eq!(value["epoch"], 1);
    assert_eq!(value["control_revision"], state.control_revision);
    assert_eq!(value["requests"][0]["client_id"], "bob");
}

#[test]
fn requests_and_refusals_keep_input_generation_but_handoff_changes_it() {
    let mut state = state();
    let initial = state.control_revision;
    let revision = state.revision;
    state.command("bob", Command::Request).unwrap();
    assert!(state.revision > revision);
    assert_eq!(state.control_revision, initial);
    state
        .command(
            "alice",
            Command::Respond {
                client_id: "bob".into(),
                accept: false,
            },
        )
        .unwrap();
    assert_eq!(state.control_revision, initial);
    state.command("bob", Command::Request).unwrap();
    state
        .command(
            "alice",
            Command::Respond {
                client_id: "bob".into(),
                accept: true,
            },
        )
        .unwrap();
    assert_eq!(state.control_revision, initial + 1);
    state.finish_handoff("alice").unwrap();
    assert_eq!(state.control_revision, initial + 2);
}

#[test]
fn missing_owner_and_confirmed_recovery_change_input_generation() {
    let mut state = state();
    let initial = state.control_revision;
    state.prune(&["alice".into()]).unwrap();
    assert_eq!(state.control_revision, initial + 1);
    state.command("master", Command::Reclaim).unwrap();
    assert_eq!(state.control_revision, initial + 1);
    state.finish_recovery("master").unwrap();
    assert_eq!(state.control_revision, initial + 2);
    state.unregister("master", true).unwrap();
    assert_eq!(state.control_revision, initial + 3);
}

static DIRECTORIES: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let serial = DIRECTORIES.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "deviceforge-ownership-{}-{timestamp}-{serial}",
            std::process::id()
        )))
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        if self.0.starts_with(std::env::temp_dir())
            && self
                .0
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("deviceforge-ownership-"))
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn operating_system_live_lock_rejects_duplicate_and_releases_on_drop() {
    let directory = TestDirectory::new();
    let first = Ownership::at(directory.0.clone(), "device", "alice").unwrap();
    assert!(Ownership::at(directory.0.clone(), "device", "alice").is_err());
    drop(first);
    let next = Ownership::at(directory.0.clone(), "device", "alice").unwrap();
    drop(next);
}

#[tokio::test]
async fn persisted_state_prunes_real_released_lock_and_keeps_failure_closed() {
    let directory = TestDirectory::new();
    let root = directory.0.clone();
    let owner = blocking(move || Ownership::at(root, "device", "alice"))
        .await
        .unwrap();
    owner.register(true, false).await.unwrap();
    let root = directory.0.clone();
    let master = blocking(move || Ownership::at(root, "device", "master"))
        .await
        .unwrap();
    master.register(true, true).await.unwrap();
    drop(owner);
    let mut guard = master.lock().await.unwrap();
    assert!(guard.view().blocked);
    guard.command(Command::Reclaim).unwrap();
    assert!(guard.needs_recovery());
    assert!(!guard.is_owner());
    guard.save().await.unwrap();
    drop(guard);
    let mut guard = master.lock().await.unwrap();
    assert!(guard.needs_recovery());
    guard.finish_recovery().unwrap();
    guard.save().await.unwrap();
    assert!(guard.is_owner());
}

#[tokio::test]
async fn unclean_live_controller_cannot_be_bypassed_by_master() {
    let directory = TestDirectory::new();
    let root = directory.0.clone();
    let owner = blocking(move || Ownership::at(root, "device", "alice"))
        .await
        .unwrap();
    owner.register(true, false).await.unwrap();
    let root = directory.0.clone();
    let master = blocking(move || Ownership::at(root, "device", "master"))
        .await
        .unwrap();
    master.register(true, true).await.unwrap();
    owner.unregister(false).await.unwrap();
    let mut guard = master.lock().await.unwrap();
    assert!(guard.command(Command::Reclaim).is_err());
    assert!(!guard.needs_recovery());
    assert!(guard.finish_recovery().is_err());
}

#[test]
fn invalid_and_oversized_json_is_rejected_and_device_names_are_hashed() {
    let directory = TestDirectory::new();
    let paths = Paths::new(directory.0.clone(), "device");
    paths.prepare().unwrap();
    let path = directory
        .0
        .join(format!("{}.json", storage::digest("device")));
    std::fs::write(&path, b"{\"version\":99}").unwrap();
    assert!(paths.read().is_err());
    std::fs::write(&path, vec![b' '; 64 * 1024 + 1]).unwrap();
    assert!(paths.read().is_err());
    assert_eq!(storage::digest("device").len(), 64);
}
