//! 新旧调用隔离：只使用临时台账、真实文件租约和注入命令。
use super::*;

fn blocked_control(root: &std::path::Path, device: &str) -> PathBuf {
    let controls = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&controls).unwrap();
    let path = controls.join(format!(
        "{}.json",
        crate::live::ownership::recovery::key(device)
    ));
    store::publish(
        &path,
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":3,"control_revision":2,"owner_id":"lost","target_id":null,
            "recovery_id":null,"transitioning":false,"blocked":true,"participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    path
}

#[tokio::test]
async fn old_corrupt_ledger_and_control_do_not_reject_independent_admission() {
    let root = root();
    let old = record("demo", 1);
    store::publish(&old.path(&root), b"{broken").unwrap();
    let control = blocked_control(&root, "demo");
    let before = store::read(&control).unwrap();
    admission::check(&root, "demo").await.unwrap();
    admission::check(&root, "other").await.unwrap();
    assert_eq!(store::read(&control).unwrap(), before);
    assert_eq!(store::read(&old.path(&root)).unwrap(), b"{broken");
    let pending = root.join(format!("{}.pending", old.token));
    std::fs::write(&pending, b"unconfirmed").unwrap();
    let fresh = record("demo", 2);
    let process = store::lock(&root.join("process.lock"), true)
        .unwrap()
        .unwrap();
    let ledger = Ledger::create_at(root.clone(), fresh.clone(), process)
        .await
        .unwrap();
    assert!(
        fresh.path(&root).exists(),
        "旧债务不能阻止真正发布 fresh token 台账"
    );
    assert_ne!(ledger.record.token, old.token);
    assert_eq!(store::read(&pending).unwrap(), b"unconfirmed");
    assert_eq!(store::read(&control).unwrap(), before);
}

#[tokio::test]
async fn old_control_result_cannot_clear_a_later_control_generation() {
    use crate::live::ownership::recovery as control;
    let root = root();
    let path = blocked_control(&root, "demo");
    let key = control::key("demo");
    let proof = control::snapshot(&root, &key).await.unwrap();
    let mut next: Value = serde_json::from_slice(&store::read(&path).unwrap()).unwrap();
    next["revision"] = serde_json::json!(4);
    next["control_revision"] = serde_json::json!(3);
    next["owner_id"] = serde_json::json!("new-session");
    store::publish(&path, &serde_json::to_vec(&next).unwrap()).unwrap();
    let before = store::read(&path).unwrap();
    assert!(control::confirm(&root, &key, proof).await.is_err());
    assert_eq!(store::read(&path).unwrap(), before);
}

#[tokio::test]
async fn reload_after_resource_pin_observes_latest_release_or_missing_record() {
    let root = root();
    let old = record("demo", 1);
    let mut latest = old.clone();
    latest.forward_stage = Stage::Released;
    write(&root, &latest);
    let current = ledger::reload(&root, &old).await.unwrap().unwrap();
    assert_eq!(current.forward_stage, Stage::Released);
    std::fs::remove_file(old.path(&root)).unwrap();
    assert!(ledger::reload(&root, &old).await.unwrap().is_none());
}

#[test]
fn force_kill_requires_term_grace_expiry_and_a_second_identity_check() {
    let value = record("demo", 1);
    let script = remote::cleanup(&value);
    let term = script.find("kill -TERM $p").unwrap();
    let force = script.find("kill -KILL $p").unwrap();
    assert!(term < force);
    assert!(script[term..force].contains("if dfml_wait; then :; else r=$?;"));
    assert!(script[term..force].contains(r#"[ "$r" = 1 ] || exit 84; dfml_identity || exit 81;"#));
    assert!(script[force..].contains("dfml_wait || exit 84; fi;"));
    assert!(
        script[force..].find("dfml_wait || exit 84").unwrap()
            < script[force..].find("rm -rf").unwrap()
    );
    assert!(!script.contains("|| continue"), "读取失败不得形成无界等待");
    for forbidden in ["pkill", "killall", "kill-server", "hdc", "--remove-all"] {
        assert!(!script.contains(forbidden));
    }
}

#[tokio::test]
async fn failed_exit_confirmation_keeps_old_record_and_never_deletes_forward() {
    let root = root();
    let mut value = record("demo", 1);
    write(&root, &value);
    let mut fake = Fake::new(vec![
        ("list", Ok(b"")),
        ("shell", Err("KILL 后仍未确认退出")),
    ]);
    assert!(runner::recover(&mut fake, &root, &mut value).await.is_err());
    assert_ne!(value.server_stage, Stage::Released);
    assert_ne!(value.directory_stage, Stage::Released);
    assert!(value.path(&root).exists());
    fake.consumed();
    assert!(
        fake.calls
            .iter()
            .all(|(_, args)| !args.iter().any(|arg| arg == "--remove"))
    );
}

#[cfg(windows)]
#[tokio::test]
async fn recovery_releases_old_resource_while_leaving_same_device_active_resource_untouched() {
    let root = root();
    let old = record("demo", 1);
    let mut active = record("demo", 2);
    active.owner = process::current().unwrap();
    active.port = Some(43);
    write(&root, &old);
    write(&root, &active);
    let process = store::lock(&root.join("process.lock"), true)
        .unwrap()
        .unwrap();
    let _active = store::lock(&root.join(format!("{}.lease", active.token)), false)
        .unwrap()
        .unwrap();
    let before = store::read(&active.path(&root)).unwrap();
    let mut fake = Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_RECOVERED\n"))]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    fake.consumed();
    assert!(report.validate());
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    assert!(!old.path(&root).exists());
    assert_eq!(store::read(&active.path(&root)).unwrap(), before);
    assert!(
        store::lock(&root.join("process.lock"), true)
            .unwrap()
            .is_some()
    );
    assert!(
        fake.calls
            .iter()
            .all(|(_, args)| !args.iter().any(|arg| arg.contains(&active.token)))
    );
    drop(process);
}

#[cfg(any(windows, target_os = "linux"))]
#[tokio::test]
async fn live_resource_is_not_a_recovery_debt_but_dead_holders_lease_remains_busy() {
    for live in [true, false] {
        let root = root();
        let mut value = record("demo", 1);
        if live {
            value.owner = process::current().unwrap();
        }
        write(&root, &value);
        let _lease = store::lock(&root.join(format!("{}.lease", value.token)), false)
            .unwrap()
            .unwrap();
        let mut fake = Fake::new(vec![]);
        let report = sweep::all(&root, None, false, &mut fake).await;
        assert_eq!(report.remaining, u32::from(!live));
        assert_eq!(
            report.status,
            if live {
                RecoveryStatus::Recovered
            } else {
                RecoveryStatus::Busy
            }
        );
        assert!(report.validate());
        assert!(fake.calls.is_empty());
        assert!(value.path(&root).exists());
    }
}

#[cfg(any(windows, target_os = "linux"))]
#[tokio::test]
async fn active_control_state_is_not_cleared_or_reported_as_old_debt() {
    let root = root();
    let mut value = record("demo", 1);
    value.owner = process::current().unwrap();
    write(&root, &value);
    let _resource = store::lock(&root.join(format!("{}.lease", value.token)), false)
        .unwrap()
        .unwrap();
    let control = blocked_control(&root, "demo");
    let key = crate::live::ownership::recovery::key("demo");
    let mut state: Value = serde_json::from_slice(&store::read(&control).unwrap()).unwrap();
    state["blocked"] = serde_json::json!(false);
    state["owner_id"] = serde_json::json!("active");
    state["participants"] =
        serde_json::json!([{"client_id":"active","allowed":true,"master":true}]);
    store::publish(&control, &serde_json::to_vec(&state).unwrap()).unwrap();
    let before = store::read(&control).unwrap();
    let _alive = store::lock(
        &control
            .parent()
            .unwrap()
            .join(format!("{key}.{}.alive", store::digest("active"))),
        false,
    )
    .unwrap()
    .unwrap();
    let mut fake = Fake::new(vec![]);
    let report = sweep::all(&root, None, false, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    assert!(report.validate());
    assert!(fake.calls.is_empty());
    assert_eq!(store::read(&control).unwrap(), before);
}

#[cfg(windows)]
struct OpeningDuringRecovery {
    fake: Fake,
    root: PathBuf,
    fresh: Record,
    opened: Option<Ledger>,
}

#[cfg(windows)]
impl runner::RecoveryRunner for OpeningDuringRecovery {
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
    fn unconfirmed(&self) -> bool {
        self.fake.unconfirmed
    }
    fn pin(&mut self, lease: Option<Arc<File>>) {
        self.fake.pin = lease;
    }
    async fn devices(&mut self) -> Result<Vec<String>, String> {
        runner::RecoveryRunner::devices(&mut self.fake).await
    }
    async fn command(&mut self, device: &str, args: Vec<String>) -> Result<Vec<u8>, String> {
        let opening = args[0] == "shell" && self.opened.is_none();
        let result = runner::RecoveryRunner::command(&mut self.fake, device, args).await;
        if opening {
            admission::check(&self.root, &self.fresh.device_id).await?;
            let process = store::lock(&self.root.join("process.lock"), true)?.unwrap();
            self.opened =
                Some(Ledger::create_at(self.root.clone(), self.fresh.clone(), process).await?);
        }
        result
    }
}

#[cfg(windows)]
#[tokio::test]
async fn resource_created_during_recovery_is_skipped_by_the_final_scan() {
    let root = root();
    let old = record("demo", 1);
    write(&root, &old);
    let mut fresh = record("demo", 2);
    fresh.owner = process::current().unwrap();
    fresh.port = Some(43);
    let mut runner = OpeningDuringRecovery {
        fake: Fake::new(vec![("list", Ok(b"")), ("shell", Ok(b"DFML_RECOVERED\n"))]),
        root: root.clone(),
        fresh: fresh.clone(),
        opened: None,
    };
    let report = sweep::all(&root, None, false, &mut runner).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    assert!(report.validate());
    assert!(!old.path(&root).exists());
    assert!(fresh.path(&root).exists());
    assert!(runner.opened.is_some());
    assert_eq!(
        runner.opened.as_ref().unwrap().record.forward_stage,
        Stage::Confirmed
    );
    runner.fake.consumed();
}
