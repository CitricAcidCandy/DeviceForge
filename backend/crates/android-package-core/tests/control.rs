use deviceforge_android_package_core::{Control, Error};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[test]
fn expired_deadline_has_priority_without_querying_cancellation() {
    let called = AtomicBool::new(false);
    let cancel = || {
        called.store(true, Ordering::Relaxed);
        true
    };
    let control = Control::new(Some(Instant::now() - Duration::from_secs(1)), &cancel);
    assert!(matches!(control.check(), Err(Error::Timeout)));
    assert!(!called.load(Ordering::Relaxed));
}

#[test]
fn no_deadline_does_not_invent_a_budget_and_queries_current_signal() {
    let cancelled = AtomicBool::new(false);
    let cancel = || cancelled.load(Ordering::Relaxed);
    let control = Control::new(None, &cancel);
    assert!(control.deadline().is_none());
    control.check().unwrap();
    cancelled.store(true, Ordering::Relaxed);
    assert!(matches!(control.check(), Err(Error::Cancelled)));
}
