use deviceforge_android_package_core::{Control, Error};
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

#[test]
fn expired_deadline_has_priority_over_cancellation() {
    let calls = AtomicUsize::new(0);
    let cancelled = || {
        calls.fetch_add(1, Ordering::SeqCst);
        true
    };
    let deadline = Instant::now() - Duration::from_secs(1);
    let control = Control::new(Some(deadline), &cancelled);

    assert!(matches!(control.check(), Err(Error::Timeout)));
    assert_eq!(control.deadline(), Some(deadline));
    // 这里直接观察公开 check 的优先级，不以回调序号定位私有 I/O 阶段。
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn future_deadline_does_not_suppress_cancellation() {
    let cancelled = || true;
    let deadline = Instant::now() + Duration::from_secs(300);
    let control = Control::new(Some(deadline), &cancelled);

    assert!(matches!(control.check(), Err(Error::Cancelled)));
    assert_eq!(control.deadline(), Some(deadline));
}

#[test]
fn no_deadline_still_observes_late_cancellation() {
    let cancelled = AtomicBool::new(false);
    let observe = || cancelled.load(Ordering::SeqCst);
    let control = Control::new(None, &observe);

    assert_eq!(control.deadline(), None);
    assert!(control.check().is_ok());
    cancelled.store(true, Ordering::SeqCst);
    assert!(matches!(control.check(), Err(Error::Cancelled)));
    assert_eq!(control.deadline(), None);
}

#[test]
fn cancellation_callback_is_rechecked_instead_of_snapshotted() {
    let cancelled = AtomicBool::new(true);
    let observe = || cancelled.load(Ordering::SeqCst);
    let control = Control::new(None, &observe);

    assert!(matches!(control.check(), Err(Error::Cancelled)));
    // Control 只借用状态；粘性 token 语义由调用方承担，核心不保存一次检查结果。
    cancelled.store(false, Ordering::SeqCst);
    assert!(control.check().is_ok());
}

#[test]
fn copies_keep_the_original_absolute_instant_between_stages() {
    let cancelled = AtomicBool::new(false);
    let observe = || cancelled.load(Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(300);
    let first_stage = Control::new(Some(deadline), &observe);
    let second_stage = first_stage;

    assert!(first_stage.check().is_ok());
    assert_eq!(first_stage.deadline(), Some(deadline));
    assert_eq!(second_stage.deadline(), Some(deadline));
    cancelled.store(true, Ordering::SeqCst);
    assert!(matches!(second_stage.check(), Err(Error::Cancelled)));
    assert_eq!(second_stage.deadline(), Some(deadline));
}

#[test]
fn already_expired_instant_is_not_restarted_by_repeated_checks() {
    let cancelled = || false;
    let deadline = Instant::now() - Duration::from_secs(1);
    let control = Control::new(Some(deadline), &cancelled);

    for stage in [control, control] {
        assert!(matches!(stage.check(), Err(Error::Timeout)));
        assert_eq!(stage.deadline(), Some(deadline));
    }
}
