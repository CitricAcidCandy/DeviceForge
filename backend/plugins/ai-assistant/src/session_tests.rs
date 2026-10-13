use super::*;
const ID: &str = "12345678-1234-1234-1234-123456789abc";

#[test]
fn new_stream_thread_registers_uncertain_zero_turns_before_any_success() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut lease = Lease::acquire(root.path(), ID, "demo", &project, &|| Ok(())).unwrap();
    lease
        .register_uncertain("demo".into(), project.clone(), ID.into(), &|| Ok(()))
        .unwrap();
    assert_eq!(lease.snapshot.as_ref().unwrap().turns, 0);
    assert!(lease.snapshot.as_ref().unwrap().uncertain);
    assert!(
        lease
            .register_uncertain("demo".into(), project.clone(), ID.into(), &|| Ok(()))
            .is_err()
    );
    drop(lease);
    let mut lease = Lease::acquire(root.path(), ID, "demo", &project, &|| Ok(())).unwrap();
    assert!(lease.begin(&|| Ok(())).is_err());
    lease
        .complete("demo".into(), project, ID.into(), &|| Ok(()))
        .unwrap();
    assert_eq!(lease.snapshot.as_ref().unwrap().turns, 1);
    assert!(!lease.snapshot.as_ref().unwrap().uncertain);
}
#[test]
fn durable_owner_close_and_uncertain_prevent_unsafe_resume() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    assert!(state.begin(&|| Ok(())).is_err());
    state
        .complete("one".into(), project.clone(), ID.into(), &|| Ok(()))
        .unwrap();
    drop(state);
    assert!(Lease::acquire(root.path(), ID, "two", &project, &|| Ok(())).is_err());
    assert!(Lease::acquire(root.path(), ID, "one", &project.join("moved"), &|| Ok(())).is_err());
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    state.begin(&|| Ok(())).unwrap();
    drop(state);
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    assert!(state.snapshot.as_ref().unwrap().uncertain);
    assert!(state.begin(&|| Ok(())).is_err());
    state.close(&|| Ok(())).unwrap();
    drop(state);
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    assert!(state.snapshot.as_ref().unwrap().closed);
    assert!(state.begin(&|| Ok(())).is_err());
}

#[test]
fn case_normalized_lock_serializes_and_cancelled_wait_does_not_mutate() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut held = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    held.complete("one".into(), project.clone(), ID.into(), &|| Ok(()))
        .unwrap();
    let started = std::time::Instant::now();
    let result = Lease::acquire(
        root.path(),
        &ID.to_ascii_uppercase(),
        "one",
        &project,
        &|| {
            if started.elapsed() > Duration::from_millis(30) {
                Err("取消".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    drop(held);
    let state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    assert!(!state.snapshot.as_ref().unwrap().uncertain);
    assert_eq!(state.snapshot.as_ref().unwrap().turns, 1);
}

#[test]
fn failed_commit_keeps_disk_and_memory_uncertain_until_success() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    state
        .complete("one".into(), project.clone(), ID.into(), &|| Ok(()))
        .unwrap();
    state.begin(&|| Ok(())).unwrap();
    let original = fs::read(&state.path).unwrap();
    assert!(
        state
            .complete("one".into(), project, ID.into(), &|| Err("取消".into()))
            .is_err()
    );
    assert!(state.snapshot.as_ref().unwrap().uncertain);
    assert_eq!(state.snapshot.as_ref().unwrap().turns, 1);
    assert_eq!(fs::read(&state.path).unwrap(), original);
    assert!(state.close(&|| Err("取消".into())).is_err());
    assert!(!state.snapshot.as_ref().unwrap().closed);
    assert_eq!(fs::read(&state.path).unwrap(), original);
}

#[test]
fn exhausted_turns_reject_before_uncertain_is_written() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    state
        .complete("one".into(), project, ID.into(), &|| Ok(()))
        .unwrap();
    let mut snapshot = state.snapshot.as_ref().unwrap().clone();
    snapshot.turns = u64::MAX;
    state.commit(snapshot, &|| Ok(())).unwrap();
    let original = fs::read(&state.path).unwrap();
    assert!(state.begin(&|| Ok(())).is_err());
    assert!(!state.snapshot.as_ref().unwrap().uncertain);
    assert_eq!(fs::read(&state.path).unwrap(), original);
}

#[test]
fn child_process_cannot_bypass_normalized_thread_lock() {
    const CHILD_ROOT: &str = "DEVICEFORGE_AI_LOCK_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let attempts = std::cell::Cell::new(0);
        let result = Lease::acquire(
            &root,
            &ID.to_ascii_uppercase(),
            "one",
            &root.join("project"),
            &|| {
                attempts.set(attempts.get() + 1);
                if attempts.get() > 4 {
                    Err("取消锁等待".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.err().as_deref(), Some("取消锁等待"));
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut held = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    held.complete("one".into(), project.clone(), ID.into(), &|| Ok(()))
        .unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "sessions::tests::child_process_cannot_bypass_normalized_thread_lock",
        ])
        .env(CHILD_ROOT, root.path())
        .status()
        .unwrap();
    assert!(status.success());
    drop(held);
    let state = Lease::acquire(root.path(), ID, "one", &project, &|| Ok(())).unwrap();
    assert_eq!(state.snapshot.as_ref().unwrap().turns, 1);
    assert!(!state.snapshot.as_ref().unwrap().uncertain);
}
