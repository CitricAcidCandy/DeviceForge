use super::*;
use std::sync::Arc;

const THREAD: &str = "12345678-1234-1234-1234-123456789abc";

#[test]
fn registration_restore_and_cancel_do_not_replay_uncertain_turns() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut lease = Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).unwrap();
    assert!(lease.begin(&|| Ok(())).is_err());
    assert!(lease.complete(&|| Ok(())).is_err());
    lease.register(&|| Ok(())).unwrap();
    assert_eq!(lease.snapshot().unwrap().provider, PROVIDER);
    assert_eq!(lease.snapshot().unwrap().turns, 0);
    assert!(lease.begin(&|| Ok(())).is_err());
    assert_eq!(lease.complete(&|| Ok(())).unwrap(), 1);
    lease.begin(&|| Ok(())).unwrap();
    drop(lease);
    let mut recovered = Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).unwrap();
    assert!(recovered.snapshot().unwrap().uncertain);
    assert!(recovered.begin(&|| Ok(())).is_err());
    recovered.close(&|| Ok(())).unwrap();
    assert!(recovered.begin(&|| Ok(())).is_err());
}

#[test]
fn provider_project_and_profile_mismatch_leave_existing_bytes() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut lease = Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).unwrap();
    lease.register(&|| Ok(())).unwrap();
    lease.complete(&|| Ok(())).unwrap();
    let path = lease.path.clone();
    drop(lease);
    assert!(Lease::acquire(root.path(), "other", &project, THREAD, &|| Ok(())).is_err());
    for field in ["provider", "profile", "sdk_version"] {
        let original = fs::read(&path).unwrap();
        let mut state: serde_json::Value = serde_json::from_slice(&original).unwrap();
        state[field] = serde_json::json!("cli");
        let mutated = serde_json::to_vec(&state).unwrap();
        fs::write(&path, &mutated).unwrap();
        assert!(Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).is_err());
        assert_eq!(fs::read(&path).unwrap(), mutated);
        fs::write(&path, &original).unwrap();
    }
}

#[test]
fn resource_clone_holds_normalized_lock_and_cancelled_commit_retains_uncertain() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let mut lease = Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).unwrap();
    lease.register(&|| Ok(())).unwrap();
    let original = fs::read(&lease.path).unwrap();
    assert!(lease.complete(&|| Err("取消".into())).is_err());
    assert!(lease.snapshot().unwrap().uncertain);
    assert_eq!(fs::read(&lease.path).unwrap(), original);
    let resource = Arc::new(lease);
    let retained = resource.clone();
    drop(resource);
    let start = std::time::Instant::now();
    assert!(
        Lease::acquire(
            root.path(),
            "demo",
            &project,
            &THREAD.to_ascii_uppercase(),
            &|| {
                if start.elapsed() >= Duration::from_millis(20) {
                    Err("取消".into())
                } else {
                    Ok(())
                }
            }
        )
        .is_err()
    );
    drop(retained);
    assert!(Lease::acquire(root.path(), "demo", &project, THREAD, &|| Ok(())).is_ok());
}
