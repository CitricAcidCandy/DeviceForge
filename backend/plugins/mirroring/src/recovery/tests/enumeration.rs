//! 空登记与旧版 DFML 迁移资格；所有设备输出均由夹具提供。
use super::*;

fn assert_read_only(fake: &Fake) {
    assert!(fake.calls.iter().all(|(_, args)| {
        !args
            .iter()
            .any(|arg| arg.contains("rm -rf") || arg.contains("kill -TERM") || arg == "--remove")
    }));
}

#[test]
fn host_risk_requires_a_boolean_but_never_proves_device_absence() {
    assert!(!host_cleanup_unconfirmed(&serde_json::json!({})).unwrap());
    for risk in [false, true] {
        assert_eq!(
            host_cleanup_unconfirmed(&serde_json::json!({"_host_cleanup_unconfirmed": risk}))
                .unwrap(),
            risk
        );
    }
    for risk in [
        Value::Null,
        Value::String("false".into()),
        serde_json::json!(0),
    ] {
        assert!(
            host_cleanup_unconfirmed(&serde_json::json!({"_host_cleanup_unconfirmed": risk}))
                .is_err()
        );
    }
}

#[test]
fn device_enumeration_is_strict_bounded_and_rejects_unavailable_devices() {
    assert_eq!(
        runner::online_devices(b"List of devices attached\r\nb\tdevice\r\na\tdevice\r\n\r\n")
            .unwrap(),
        vec!["a", "b"]
    );
    assert!(
        runner::online_devices(b"List of devices attached\n\n")
            .unwrap()
            .is_empty()
    );
    for output in [
        b"".as_slice(),
        b"a\tdevice\n",
        b"List of devices attached\na\toffline\n",
        b"List of devices attached\na\tunauthorized\n",
        b"List of devices attached\na\tno permissions\n",
        b"List of devices attached\na\tdevice\na\tdevice\n",
        b"List of devices attached\n-s\tdevice\n",
        b"List of devices attached\na;id\tdevice\n",
        b"List of devices attached\na\tdevice extra\n",
        b"List of devices attached\na\n",
        b"List of devices attached\n\xff\n",
    ] {
        assert!(runner::online_devices(output).is_err(), "{output:?}");
    }
    let oversized = vec![b'x'; 8193];
    assert!(runner::online_devices(&oversized).is_err());
    let mut many = "List of devices attached\n".to_owned();
    for ordinal in 0..129 {
        many.push_str(&format!("device-{ordinal}\tdevice\n"));
    }
    assert!(runner::online_devices(many.as_bytes()).is_err());
}

#[tokio::test]
async fn empty_legacy_catalog_audits_every_online_device_even_after_host_risk_is_lost() {
    for risk in [true, false] {
        let root = root();
        assert!(!root.parent().unwrap().join(".mirroring-control").exists());
        let mut fake = Fake::new(vec![
            (
                "devices",
                Ok(b"List of devices attached\nb\tdevice\na\tdevice\n\n"),
            ),
            ("list", Ok(b"")),
            ("shell", Ok(b"DFML_AUDITED\n")),
            ("list", Ok(b"")),
            ("shell", Ok(b"DFML_AUDITED\n")),
        ]);
        let report = sweep::all(&root, None, risk, &mut fake).await;
        assert_eq!(report.status, RecoveryStatus::Recovered);
        assert_eq!(report.inspected, 2);
        assert_eq!(report.remaining, 0);
        assert!(report.validate());
        assert_eq!(
            fake.calls
                .iter()
                .map(|(device, _)| device.as_str())
                .collect::<Vec<_>>(),
            vec!["", "a", "a", "b", "b"]
        );
        fake.consumed();
        assert_read_only(&fake);
    }
}

#[tokio::test]
async fn empty_legacy_catalog_with_unconfirmed_risk_and_no_devices_stays_blocked() {
    let root = root();
    let mut fake = Fake::new(vec![("devices", Ok(b"List of devices attached\n\n"))]);
    let report = sweep::all(&root, None, true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert_eq!(report.remaining, 1);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.message.contains("选择故障设备"))
    );
    assert!(report.validate());
    fake.consumed();
}

#[tokio::test]
async fn empty_catalog_without_risk_or_devices_only_confirms_registered_resource_absence() {
    let root = root();
    let mut fake = Fake::new(vec![("devices", Ok(b"List of devices attached\n\n"))]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.inspected, 0);
    assert!(report.message.contains("无已登记资源"));
    assert!(report.message.contains("独立资源"));
    assert!(report.validate());
    fake.consumed();
}

#[tokio::test]
async fn empty_legacy_catalog_never_recovers_on_enumeration_failure_or_unavailable_device() {
    for output in [
        Err("枚举失败"),
        Ok(b"List of devices attached\ndemo\toffline\n".as_slice()),
        Ok(b"List of devices attached\ndemo\tunauthorized\n".as_slice()),
    ] {
        let root = root();
        let mut fake = Fake::new(vec![("devices", output)]);
        let report = sweep::all(&root, None, false, &mut fake).await;
        assert_eq!(report.status, RecoveryStatus::Blocked);
        assert!(report.remaining > 0);
        assert!(report.validate());
        fake.consumed();
        assert_read_only(&fake);
    }
}

#[tokio::test]
async fn legacy_dfml_without_ownership_or_ledger_never_gets_a_false_recovery() {
    for risk in [false, true] {
        let root = root();
        let mut fake = Fake::new(vec![
            ("devices", Ok(b"List of devices attached\ndemo\tdevice\n")),
            ("list", Ok(b"demo tcp:42 localabstract:scrcpy_00000001\n")),
        ]);
        let report = sweep::all(&root, None, risk, &mut fake).await;
        assert_eq!(report.status, RecoveryStatus::Blocked);
        assert_eq!(report.inspected, 1);
        assert_eq!(report.remaining, 1);
        assert!(report.validate());
        fake.consumed();
        assert_read_only(&fake);
    }
}

#[tokio::test]
async fn failed_legacy_audit_does_not_hide_other_online_devices() {
    let root = root();
    let mut fake = Fake::new(vec![
        (
            "devices",
            Ok(b"List of devices attached\na\tdevice\nb\tdevice\n"),
        ),
        ("list", Ok(b"")),
        ("shell", Err("发现旧目录或服务进程")),
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert_eq!((report.inspected, report.remaining), (2, 1));
    assert!(report.validate());
    fake.consumed();
    assert_read_only(&fake);
}

#[tokio::test]
async fn first_open_does_not_require_a_legacy_device_audit() {
    let root = root();
    admission::check(&root, "demo").await.unwrap();
    assert!(ledger::read_all(&root).await.unwrap().is_empty());
}

#[tokio::test]
async fn first_open_never_removes_an_unowned_external_scrcpy_forward() {
    let root = root();
    admission::check(&root, "demo").await.unwrap();
    // 只有显式后台核对才读取转发；发现外来资源保留债务而不影响下一次准入。
    let mut fake = Fake::new(vec![(
        "list",
        Ok(b"demo tcp:42 localabstract:scrcpy_external\n"),
    )]);
    let report = sweep::all(&root, Some("demo"), false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    fake.consumed();
    assert_read_only(&fake);
    admission::check(&root, "demo").await.unwrap();
}

#[cfg(any(windows, target_os = "linux"))]
#[tokio::test]
async fn trusted_live_record_keeps_additional_viewers_out_of_legacy_audit() {
    let root = root();
    let mut value = record("demo", 1);
    value.owner = process::current().unwrap();
    write(&root, &value);
    let _lease = store::lock(&root.join(format!("{}.lease", value.token)), false)
        .unwrap()
        .unwrap();
    admission::check(&root, "demo").await.unwrap();
    assert!(value.path(&root).exists());
}

#[tokio::test]
async fn explicit_target_without_other_records_never_enumerates_or_audits_other_devices() {
    let root = root();
    let mut fake = Fake::new(vec![
        (
            "list",
            Ok(b"samsung tcp:43 localabstract:scrcpy_external\n"),
        ),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, Some("ptp"), true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert!(report.validate());
    assert!(fake.calls.iter().all(|(device, _)| device == "ptp"));
    fake.consumed();
    assert_read_only(&fake);
}

#[tokio::test]
async fn clean_control_history_is_not_proof_that_an_unregistered_legacy_dfml_is_absent() {
    let root = root();
    let controls = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&controls).unwrap();
    let key = crate::live::ownership::recovery::key("demo");
    store::publish(
        &controls.join(format!("{key}.json")),
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":3,"control_revision":2,"owner_id":null,"target_id":null,
            "recovery_id":null,"transitioning":false,"blocked":false,"participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut fake = Fake::new(vec![
        ("devices", Ok(b"List of devices attached\ndemo\tdevice\n")),
        ("list", Ok(b"demo tcp:42 localabstract:scrcpy_legacy\n")),
    ]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0);
    assert!(report.validate());
    fake.consumed();
    assert_read_only(&fake);
}
