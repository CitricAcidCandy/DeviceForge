//! 已确认阶段只能续办，不能重新主张已释放的端口或重复删除。
use super::*;

fn released(value: &mut Record) {
    value.directory_stage = Stage::Released;
    value.upload_stage = Stage::Released;
    value.server_stage = Stage::Released;
    value.forward_stage = Stage::Released;
}

#[tokio::test]
async fn fully_released_record_never_reclaims_its_old_port_or_repeats_remote_deletion() {
    let root = root();
    let mut value = record("demo", 1);
    released(&mut value);
    write(&root, &value);
    let mut fake = Fake::new(vec![]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    assert!(fake.calls.is_empty());
    assert!(value.path(&root).exists(), "控制审计尚未完成，记录仍须保留");
}

#[tokio::test]
async fn released_forward_does_not_block_remaining_remote_cleanup() {
    let root = root();
    let mut value = record("demo", 1);
    value.forward_stage = Stage::Released;
    write(&root, &value);
    let mut fake = Fake::new(vec![("shell", Ok(b"DFML_RECOVERED\n"))]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    assert_eq!(value.directory_stage, Stage::Released);
    assert_eq!(fake.calls.len(), 1);
    fake.consumed();
}

#[tokio::test]
async fn released_directory_does_not_repeat_cleanup_when_only_forward_is_pending() {
    let root = root();
    let mut value = record("demo", 1);
    value.directory_stage = Stage::Released;
    value.upload_stage = Stage::Released;
    value.server_stage = Stage::Released;
    write(&root, &value);
    let owned = b"demo tcp:42 localabstract:scrcpy_00000001\n".as_slice();
    let mut fake = Fake::new(vec![
        ("list", Ok(owned)),
        ("list", Ok(owned)),
        ("remove", Ok(b"")),
        ("list", Ok(b"")),
    ]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    assert!(fake.calls.iter().all(|(_, args)| args[0] != "shell"));
    assert_eq!(value.forward_stage, Stage::Released);
    fake.consumed();
}

#[tokio::test]
async fn released_directory_receipt_can_finish_an_interrupted_stage_journal_tail() {
    let root = root();
    let mut value = record("demo", 1);
    value.directory_stage = Stage::Released;
    value.forward_stage = Stage::Released;
    write(&root, &value);
    let mut fake = Fake::new(vec![]);
    runner::recover(&mut fake, &root, &mut value).await.unwrap();
    let saved = ledger::read_all(&root).await.unwrap();
    assert_eq!(saved[0].upload_stage, Stage::Released);
    assert_eq!(saved[0].server_stage, Stage::Released);
    assert!(fake.calls.is_empty());
}

#[tokio::test]
async fn unreleased_forward_still_rejects_foreign_reuse_after_directory_release() {
    let root = root();
    let mut value = record("demo", 1);
    value.directory_stage = Stage::Released;
    write(&root, &value);
    let mut fake = Fake::new(vec![("list", Ok(b"other tcp:42 localabstract:foreign\n"))]);
    assert!(runner::recover(&mut fake, &root, &mut value).await.is_err());
    assert_ne!(value.forward_stage, Stage::Released);
    fake.consumed();
    assert_eq!(fake.calls.len(), 1);
}

#[cfg(windows)]
#[tokio::test]
async fn released_port_reused_by_another_device_does_not_block_remaining_control_audit() {
    let root = root();
    let mut value = record("demo", 1);
    released(&mut value);
    write(&root, &value);
    let controls = root.parent().unwrap().join(".mirroring-control");
    std::fs::create_dir_all(&controls).unwrap();
    let key = crate::live::ownership::recovery::key("demo");
    let path = controls.join(format!("{key}.json"));
    store::publish(
        &path,
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"revision":3,"control_revision":2,"owner_id":"lost","target_id":null,
            "recovery_id":null,"transitioning":false,"blocked":true,"participants":[],"requests":[]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut fake = Fake::new(vec![
        ("list", Ok(b"other tcp:42 localabstract:scrcpy_foreign\n")),
        ("shell", Ok(b"DFML_AUDITED\n")),
    ]);
    let report = sweep::all(&root, Some("demo"), true, &mut fake).await;
    assert_eq!(report.status, RecoveryStatus::Recovered);
    assert_eq!(report.remaining, 0);
    assert!(report.validate());
    assert!(!value.path(&root).exists());
    let state: Value = serde_json::from_slice(&store::read(&path).unwrap()).unwrap();
    assert_eq!(state["blocked"], false);
    assert_eq!(state["revision"], 4);
    assert!(fake.calls.iter().all(|(_, args)| {
        !args
            .iter()
            .any(|arg| arg.contains("rm -rf") || arg.contains("kill -TERM") || arg == "--remove")
    }));
    fake.consumed();
}
