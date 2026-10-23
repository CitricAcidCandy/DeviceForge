//! 不连接设备：使用真实文件锁与注入命令验证恢复边界。
mod catalog;
mod enumeration;
mod stages;

use super::*;
use std::{
    collections::VecDeque,
    fs::File,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT: AtomicU64 = AtomicU64::new(1);

fn root() -> PathBuf {
    let root = std::env::temp_dir()
        .join(format!(
            "deviceforge-recovery-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
        .join(".mirroring-resources");
    store::prepare(&root).unwrap();
    root
}

fn record(device: &str, ordinal: u32) -> Record {
    let token = format!("{ordinal:032x}");
    Record {
        version: 1,
        device_id: device.into(),
        directory: format!("/data/local/tmp/deviceforge_{token}"),
        token,
        scid: format!("{ordinal:08x}"),
        port: Some(42),
        server_version: "3.3.4".into(),
        externally_managed: false,
        owner: process::Identity {
            pid: u32::MAX,
            birth: "1".into(),
        },
        directory_stage: Stage::Confirmed,
        upload_stage: Stage::Confirmed,
        forward_stage: Stage::Confirmed,
        server_stage: Stage::Confirmed,
        remote: None,
    }
}

fn write(root: &std::path::Path, record: &Record) {
    store::publish(&record.path(root), &serde_json::to_vec(record).unwrap()).unwrap();
}

#[test]
fn recovery_accepts_original_live_parameters_without_replaying_them() {
    assert_eq!(
        target(
            &serde_json::json!({"device_id":"demo","control":true,"audio":false,"max_size":1280})
        )
        .unwrap(),
        Some("demo")
    );
    assert_eq!(target(&serde_json::json!({})).unwrap(), None);
    for input in [
        serde_json::json!(null),
        serde_json::json!([]),
        serde_json::json!({"device_id":null}),
        serde_json::json!({"device_id":"-s"}),
        serde_json::json!({"device_id":"a;id"}),
    ] {
        assert!(target(&input).is_err());
    }
}

#[test]
fn ledger_rejects_path_escape_unknown_version_and_unsafe_identity() {
    let safe = record("demo", 1);
    assert!(safe.validate().is_ok());
    let mut value = safe.clone();
    value.directory.push_str("/..");
    assert!(value.validate().is_err());
    let mut value = safe.clone();
    value.token = "../outside".into();
    assert!(value.validate().is_err());
    let mut value = safe.clone();
    value.scid = "0;id".into();
    assert!(value.validate().is_err());
    let mut value = safe.clone();
    value.server_version = "5.0.1".into();
    assert!(value.validate().is_err());
    let mut value = safe;
    value.port = Some(0);
    assert!(value.validate().is_err());
}

#[test]
fn shared_process_leases_and_exclusive_recovery_are_mutually_exclusive() {
    let root = root();
    let path = root.join("process.lock");
    let first = store::lock(&path, true).unwrap().unwrap();
    let second = store::lock(&path, true).unwrap().unwrap();
    assert!(store::lock(&path, false).unwrap().is_none());
    drop(first);
    assert!(store::lock(&path, false).unwrap().is_none());
    drop(second);
    let exclusive = store::lock(&path, false).unwrap().unwrap();
    assert!(store::lock(&path, true).unwrap().is_none());
    assert!(store::lock(&path, false).unwrap().is_none());
    drop(exclusive);
    assert!(store::lock(&path, true).unwrap().is_some());
    assert!(path.exists(), "永久锁文件不能删除");
}

#[test]
fn resource_lease_is_retained_by_tool_owner_until_last_reference_is_dropped() {
    let root = root();
    let resource_path = root.join("resource.lease");
    let process_path = root.join("process.lock");
    let lease = Arc::new(ledger::ToolLease {
        _resource: store::lock(&resource_path, false).unwrap().unwrap(),
        _process: store::lock(&process_path, true).unwrap().unwrap(),
    });
    let supervision = lease.clone();
    drop(lease);
    assert!(store::lock(&resource_path, false).unwrap().is_none());
    assert!(store::lock(&process_path, false).unwrap().is_none());
    drop(supervision);
    assert!(store::lock(&resource_path, false).unwrap().is_some());
    assert!(store::lock(&process_path, false).unwrap().is_some());
}

#[tokio::test]
async fn device_creation_and_recovery_share_one_exclusive_gate() {
    let root = root();
    let gate = store::device_gate(&root, "demo").await.unwrap();
    assert!(store::device_gate(&root, "demo").await.is_err());
    assert!(store::device_gate(&root, "other").await.is_ok());
    drop(gate);
    assert!(store::device_gate(&root, "demo").await.is_ok());
}

#[tokio::test]
async fn durable_record_rescans_after_reopen_and_corruption_fails_closed() {
    let root = root();
    let value = record("demo", 1);
    write(&root, &value);
    let records = ledger::read_all(&root).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].device_id, "demo");
    store::publish(&value.path(&root), b"{}").unwrap();
    assert!(ledger::read_all(&root).await.is_err());
    assert!(value.path(&root).exists());
}

#[test]
fn pid_reuse_checks_birth_boot_classpath_and_token_before_any_signal() {
    let mut value = record("demo", 1);
    value.remote = Some(ledger::RemoteIdentity {
        pid: 123,
        start: "999".into(),
        boot: "12345678-1234-1234-1234-123456789abc".into(),
    });
    let script = remote::cleanup(&value);
    let signal = script.find("kill -TERM $p").unwrap();
    for marker in [
        "[ \"$p\" = 123 ]",
        "[ \"$s\" = 999 ]",
        "boot_id",
        "CLASSPATH=",
        "grep -Fxq 3.3.4",
        "/owner",
        "/proc/$p/stat",
    ] {
        assert!(script.find(marker).unwrap() < signal);
    }
    assert!(!script.contains("pkill"));
    assert!(!script.contains("kill-server"));
    assert_eq!(script.matches("kill -TERM").count(), 1);
}

#[test]
fn forward_requires_unique_serial_scid_and_unreused_local_port() {
    let value = record("demo", 1);
    assert_eq!(
        remote::forward(b"demo tcp:42 localabstract:scrcpy_00000001\n", &value).unwrap(),
        Some(42)
    );
    assert_eq!(
        remote::forward(b"other tcp:43 localabstract:scrcpy_foreign\n", &value).unwrap(),
        None
    );
    for output in [
        b"other tcp:42 localabstract:scrcpy_00000001\n".as_slice(),
        b"demo tcp:42 localabstract:scrcpy_foreign\n",
        b"demo tcp:43 localabstract:scrcpy_00000001\n",
        b"demo tcp:42 localabstract:scrcpy_00000001\ndemo tcp:43 localabstract:scrcpy_00000001\n",
        b"demo tcp:42 localabstract:scrcpy_00000001\nother tcp:42 localabstract:foreign\n",
    ] {
        assert!(remote::forward(output, &value).is_err());
    }
}

struct Fake {
    steps: VecDeque<(String, Result<Vec<u8>, String>)>,
    calls: Vec<(String, Vec<String>)>,
    unconfirmed: bool,
    pin: Option<Arc<File>>,
}

impl Fake {
    fn new(steps: Vec<(&str, Result<&[u8], &str>)>) -> Self {
        Self {
            steps: steps
                .into_iter()
                .map(|(kind, result)| (kind.into(), result.map(Vec::from).map_err(String::from)))
                .collect(),
            calls: Vec::new(),
            unconfirmed: false,
            pin: None,
        }
    }
    fn consumed(&self) {
        assert!(self.steps.is_empty());
    }
    fn step(&mut self, kind: &str, device: &str, args: Vec<String>) -> Result<Vec<u8>, String> {
        let (expected, result) = self
            .steps
            .pop_front()
            .expect("不允许执行计划之外的恢复命令");
        assert_eq!(expected, kind);
        self.calls.push((device.into(), args));
        result
    }
}

impl runner::RecoveryRunner for Fake {
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
    fn unconfirmed(&self) -> bool {
        self.unconfirmed
    }
    fn pin(&mut self, lease: Option<Arc<File>>) {
        self.pin = lease;
    }
    async fn devices(&mut self) -> Result<Vec<String>, String> {
        let output = self.step("devices", "", vec!["devices".into()])?;
        runner::online_devices(&output)
    }
    async fn command(&mut self, device: &str, args: Vec<String>) -> Result<Vec<u8>, String> {
        let kind = if args[0] == "shell" {
            "shell"
        } else if args[1] == "--list" {
            "list"
        } else {
            "remove"
        };
        self.step(kind, device, args)
    }
}

#[tokio::test]
async fn foreign_port_conflict_stops_before_remote_kill_or_remove() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let mut fake = Fake::new(vec![("list", Ok(b"other tcp:42 localabstract:foreign\n"))]);
    assert!(runner::recover(&mut fake, &root, &mut value).await.is_err());
    assert_eq!(fake.calls.len(), 1);
    assert!(value.path(&root).exists());
    fake.consumed();
}

#[tokio::test]
async fn successful_resource_recovery_persists_released_stages_but_does_not_remove_record_early() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let owned = b"demo tcp:42 localabstract:scrcpy_00000001\n".as_slice();
    let mut fake = Fake::new(vec![
        ("list", Ok(owned)),
        ("shell", Ok(b"DFML_RECOVERED\n")),
        ("list", Ok(owned)),
        ("remove", Ok(b"")),
        ("list", Ok(b"")),
    ]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    fake.consumed();
    let saved = ledger::read_all(&root).await.unwrap();
    assert_eq!(saved[0].directory_stage, Stage::Released);
    assert_eq!(saved[0].server_stage, Stage::Released);
    assert_eq!(saved[0].forward_stage, Stage::Released);
    assert!(value.path(&root).exists(), "协调状态确认前不能提前撤销台账");
}

#[tokio::test]
async fn lost_remove_reply_requires_followup_confirmation() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let owned = b"demo tcp:42 localabstract:scrcpy_00000001\n".as_slice();
    let mut fake = Fake::new(vec![
        ("list", Ok(owned)),
        ("shell", Ok(b"DFML_RECOVERED\n")),
        ("list", Ok(owned)),
        ("remove", Err("模拟回执丢失")),
        ("list", Ok(b"")),
    ]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    fake.consumed();
    assert_eq!(value.forward_stage, Stage::Released);
}

#[tokio::test]
async fn direct_process_unconfirmed_cannot_be_overwritten_by_empty_forward_table() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let owned = b"demo tcp:42 localabstract:scrcpy_00000001\n".as_slice();
    let mut fake = Fake::new(vec![
        ("list", Ok(owned)),
        ("shell", Ok(b"DFML_RECOVERED\n")),
        ("list", Ok(owned)),
        ("remove", Err("模拟直接进程收口失败")),
    ]);
    fake.unconfirmed = true;
    assert!(runner::recover(&mut fake, &root, &mut value).await.is_err());
    fake.consumed();
    assert_ne!(value.forward_stage, Stage::Released);
    assert!(value.path(&root).exists());
}

#[tokio::test]
async fn invalid_remote_receipt_preserves_record_and_prevents_forward_delete() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let mut fake = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"unexpected\n"))]);
    assert!(runner::recover(&mut fake, &root, &mut value).await.is_err());
    fake.consumed();
    assert_eq!(value.directory_stage, Stage::Confirmed);
    assert!(value.path(&root).exists());
}

#[test]
fn remote_identity_receipt_is_bounded_and_pid_zero_is_rejected() {
    let value = record("demo", 1);
    let good = b"DFML_ID 123 999 12345678-1234-1234-1234-123456789abc\n";
    let identity = remote::parse_identity(good, &value).unwrap();
    assert_eq!(identity.pid, 123);
    for output in [
        b"DFML_ID 0 999 12345678-1234-1234-1234-123456789abc\n".as_slice(),
        b"DFML_ID 123 not-a-time boot\n",
        b"DFML_ID 123 99 boot\nextra",
    ] {
        assert!(remote::parse_identity(output, &value).is_err());
    }
}

#[tokio::test]
async fn missing_device_for_legacy_blocked_state_is_not_a_global_success() {
    let root = root();
    let control_root = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&control_root).unwrap();
    let key = crate::live::ownership::recovery::key("unknown-device");
    store::publish(
        &control_root.join(format!("{key}.json")),
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":3,"control_revision":2,"owner_id":"lost","target_id":null,
            "recovery_id":null,"transitioning":false,"blocked":true,"participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut fake = Fake::new(vec![("devices", Ok(b"List of devices attached\n\n"))]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0);
    assert_eq!(report.coverage, "plugin");
    assert_eq!(report.inspected, 1);
    assert!(report.validate());
    assert_eq!(fake.calls.len(), 1);
    fake.consumed();
}

#[tokio::test]
async fn explicit_legacy_target_is_audited_before_blocked_state_is_cleared() {
    let root = root();
    let control_root = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&control_root).unwrap();
    let key = crate::live::ownership::recovery::key("demo");
    let path = control_root.join(format!("{key}.json"));
    store::publish(
        &path,
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":3,"control_revision":2,"owner_id":"lost","target_id":null,
            "recovery_id":null,"transitioning":false,"blocked":true,"participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut failed = Fake::new(vec![("list", Ok(b"")), ("shell", Err("仍有旧资源"))]);
    let report = sweep::all(&root, Some("demo"), false, &mut failed).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0);
    failed.consumed();
    let state: Value = serde_json::from_slice(&store::read(&path).unwrap()).unwrap();
    assert_eq!(state["blocked"], true);
    let mut clean = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_AUDITED\n"))]);
    let report = sweep::all(&root, Some("demo"), false, &mut clean).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    clean.consumed();
    let state: Value = serde_json::from_slice(&store::read(&path).unwrap()).unwrap();
    assert_eq!(state["blocked"], false);
    assert_eq!(state["revision"], 4);
    assert_eq!(state["control_revision"], 3);
}

#[tokio::test]
async fn active_resource_lease_is_busy_without_any_remote_command() {
    let root = root();
    let value = record("demo", 1);
    write(&root, &value);
    let _lease = store::lock(&root.join(format!("{}.lease", value.token)), false)
        .unwrap()
        .unwrap();
    let mut fake = Fake::new(vec![]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Busy);
    assert_eq!(report.remaining, 1);
    assert_eq!(report.inspected, 1);
    assert!(report.validate());
    assert!(fake.calls.is_empty());
}

#[cfg(windows)]
#[tokio::test]
async fn target_a_does_not_hide_failed_device_b_and_records_are_not_dropped() {
    let root = root();
    let a = record("a", 1);
    let b = record("b", 2);
    write(&root, &a);
    write(&root, &b);
    let mut fake = Fake::new(vec![
        ("list", Ok(b"")),
        ("shell", Ok(b"DFML_RECOVERED\n")),
        ("list", Err("设备离线，不能清理")),
    ]);
    let report = sweep::all(&root, Some("a"), false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert_eq!(report.remaining, 1);
    assert_eq!(report.inspected, 2);
    assert!(report.validate());
    fake.consumed();
    assert!(!a.path(&root).exists());
    assert!(b.path(&root).exists());
    assert_eq!(fake.calls.last().unwrap().0, "b");
}

#[cfg(windows)]
#[tokio::test]
async fn next_open_reconciles_nonempty_stale_ledger_and_removes_it_only_after_confirmation() {
    let root = root();
    let value = record("demo", 1);
    write(&root, &value);
    let mut failed = Fake::new(vec![("list", Err("设备暂时离线"))]);
    assert!(sweep::device(&root, "demo", &mut failed).await.is_err());
    assert!(value.path(&root).exists());
    let mut ready = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_RECOVERED\n"))]);
    sweep::device(&root, "demo", &mut ready).await.unwrap();
    ready.consumed();
    assert!(!value.path(&root).exists());
    let mut reopen = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_AUDITED\n"))]);
    sweep::device(&root, "demo", &mut reopen).await.unwrap();
    reopen.consumed();
}

#[tokio::test]
async fn malformed_or_excessive_catalog_fails_closed_and_never_truncates_to_success() {
    let root = root();
    for ordinal in 1..=49 {
        write(&root, &record("demo", ordinal));
    }
    let mut fake = Fake::new(vec![]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Blocked);
    assert!(report.remaining > 0);
    assert!(report.validate());
    assert!(report.checks.len() <= 64);
    assert!(fake.calls.is_empty());
}

#[test]
fn manifest_recovery_is_not_an_ordinary_business_contribution() {
    let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
    assert_eq!(manifest["recovery"]["operation"], "runtime.recover");
    assert_eq!(manifest["recovery"]["timeout_ms"], 30_000);
    assert!(
        manifest["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation["name"] != "runtime.recover")
    );
}

#[test]
fn external_recording_debt_cannot_claim_a_foreign_directory_or_forward() {
    let mut value = record("demo", 1);
    value.externally_managed = true;
    assert!(value.validate().is_err());
    value.directory.clear();
    value.scid.clear();
    value.port = None;
    value.server_version = "external".into();
    assert!(value.validate().is_ok());
}

#[tokio::test]
async fn external_recording_debt_only_audits_and_never_sends_remote_delete() {
    let root = root();
    let mut value = record("demo", 1);
    value.externally_managed = true;
    value.directory.clear();
    value.scid.clear();
    value.port = None;
    value.server_version = "external".into();
    write(&root, &value);
    let mut fake = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_AUDITED\n"))]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    fake.consumed();
    assert!(fake.calls.iter().all(|(_, args)| {
        !args
            .iter()
            .any(|arg| arg.contains("rm -rf") || arg.contains("kill -TERM") || arg == "--remove")
    }));
    assert_eq!(value.server_stage, Stage::Released);
    assert!(value.path(&root).exists());
}
