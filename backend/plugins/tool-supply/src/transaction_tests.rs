//! 在真实重命名前后撤销业务资格，核对旧目录与备份的实际恢复结果。
use super::*;
use std::cell::Cell;

#[test]
fn cancellation_before_and_after_publish_restores_previous_directory() {
    for stop in [1, 2, 3] {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let payload = root.path().join("payload");
        let backup = root.path().join("backup");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("tool"), b"old").unwrap();
        fs::create_dir(&payload).unwrap();
        fs::write(payload.join("tool"), b"new").unwrap();
        let checks = Cell::new(0);
        let result = replace_checked(&target, &payload, &backup, &|| {
            checks.set(checks.get() + 1);
            if checks.get() == stop {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(Error::Cancelled)));
        assert_eq!(fs::read(target.join("tool")).unwrap(), b"old");
        assert!(!backup.exists());
    }
}

#[test]
fn cancelled_first_install_does_not_leave_published_directory() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let payload = root.path().join("payload");
    let backup = root.path().join("backup");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("tool"), b"new").unwrap();
    let checks = Cell::new(0);
    assert!(matches!(
        replace_checked(&target, &payload, &backup, &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                Err(Error::Timeout)
            } else {
                Ok(())
            }
        }),
        Err(Error::Timeout)
    ));
    assert!(!target.exists());
    assert!(!backup.exists());
}
