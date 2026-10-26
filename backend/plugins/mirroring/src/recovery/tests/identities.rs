//! 旧 USB 标识切换无线连接后，严格关联控制摘要并只读确认资源。
use super::*;
use crate::live::ownership::recovery::{self as control, Inspection};

fn old_control(root: &std::path::Path, device: &str) -> String {
    let directory = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&directory).unwrap();
    let key = control::key(device);
    store::publish(
        &directory.join(format!("{key}.json")),
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":7,"control_revision":3,"owner_id":"lost",
            "target_id":null,"recovery_id":null,"transitioning":false,"blocked":true,
            "participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    key
}

fn assert_read_only(fake: &Fake) {
    assert!(fake.calls.iter().all(|(_, args)| {
        !args
            .iter()
            .any(|arg| arg.contains("rm -rf") || arg.contains("kill -TERM") || arg == "--remove")
    }));
}

#[tokio::test]
async fn usb_control_identity_is_recovered_through_verified_wireless_transport() {
    let root = root();
    let key = old_control(&root, "old-usb");
    let mut fake = Fake::new(vec![
        (
            "devices",
            Ok(b"List of devices attached\n192.0.2.1:8100\tdevice\n"),
        ),
        ("shell", Ok(b"old-usb\n")),
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_AUDITED\n")),
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, Some("ptp"), true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    assert!(report.validate());
    assert_eq!(
        control::inspect(&root, &key, false).await.unwrap(),
        Inspection::Clean
    );
    assert_eq!(
        fake.calls[1],
        (
            "192.0.2.1:8100".into(),
            vec!["shell".into(), "getprop".into(), "ro.serialno".into()]
        )
    );
    assert!(
        fake.calls[1..4]
            .iter()
            .all(|(device, _)| device == "192.0.2.1:8100")
    );
    assert!(fake.calls[4..].iter().all(|(device, _)| device == "ptp"));
    fake.consumed();
    assert_read_only(&fake);
}

#[tokio::test]
async fn a_different_hardware_identity_never_clears_old_control_state() {
    let root = root();
    let key = old_control(&root, "old-usb");
    let mut fake = Fake::new(vec![
        (
            "devices",
            Ok(b"List of devices attached\nwireless\tdevice\n"),
        ),
        ("shell", Ok(b"other-device\n")),
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, Some("ptp"), true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0 && report.validate());
    assert_eq!(
        control::inspect(&root, &key, false).await.unwrap(),
        Inspection::NeedsProof
    );
    assert!(fake.calls[2..].iter().all(|(device, _)| device == "ptp"));
    fake.consumed();
    assert_read_only(&fake);
}

#[tokio::test]
async fn missing_malformed_or_failed_hardware_read_cannot_create_a_mapping() {
    for output in [
        Ok(b"".as_slice()),
        Ok(b"a\nb\n"),
        Ok(b"a;id\n"),
        Err("设备读取失败"),
    ] {
        let root = root();
        let key = old_control(&root, "old-usb");
        let mut fake = Fake::new(vec![
            (
                "devices",
                Ok(b"List of devices attached\nwireless\tdevice\n"),
            ),
            ("shell", output),
        ]);
        let report = sweep::all(&root, Some("ptp"), true, &mut fake).await;
        assert_eq!(report.status, RecoveryStatus::Blocked);
        assert!(report.remaining > 0 && report.validate());
        assert_eq!(
            control::inspect(&root, &key, false).await.unwrap(),
            Inspection::NeedsProof
        );
        fake.consumed();
        assert_read_only(&fake);
    }
}

#[tokio::test]
async fn verified_wireless_identity_still_requires_resource_audit_before_control_clear() {
    let root = root();
    let key = old_control(&root, "old-usb");
    let mut fake = Fake::new(vec![
        (
            "devices",
            Ok(b"List of devices attached\nwireless\tdevice\n"),
        ),
        ("shell", Ok(b"old-usb\n")),
        (
            "list",
            Ok(b"wireless tcp:42 localabstract:scrcpy_external\n"),
        ),
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, Some("ptp"), true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0 && report.validate());
    assert_eq!(
        control::inspect(&root, &key, false).await.unwrap(),
        Inspection::NeedsProof
    );
    fake.consumed();
    assert_read_only(&fake);
}
