use super::*;

#[test]
fn retained_tool_lease_prevents_complete_even_for_other_business_failure() {
    let lifecycle = Lifecycle::default();
    let resource = lifecycle.lease.clone();
    let execution = lifecycle.finish(
        "tool".into(),
        Err(ToolError::Cancelled),
        Some(Error::Cancelled),
    );
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(resource.unresolved.load(Ordering::Acquire));
}

#[test]
fn actual_lease_release_allows_failure_with_complete_cleanup() {
    let lifecycle = Lifecycle::default();
    let execution = lifecycle.finish(
        "tool".into(),
        Err(ToolError::Cancelled),
        Some(Error::Cancelled),
    );
    assert_eq!(execution.cleanup, CleanupOutcome::Complete);
    assert_eq!(execution.outcome.err().unwrap(), "终端操作已取消");
}

#[test]
fn dropping_lifecycle_keeps_unconfirmed_marker_sticky() {
    let lifecycle = Lifecycle::default();
    let resources = lifecycle.lease.clone();
    drop(lifecycle);
    assert!(resources.unresolved.load(Ordering::Acquire));
    let later = Lifecycle {
        lease: resources,
        confirmed: false,
    };
    let execution = later.finish("tool".into(), Err(ToolError::Cancelled), None);
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
}
