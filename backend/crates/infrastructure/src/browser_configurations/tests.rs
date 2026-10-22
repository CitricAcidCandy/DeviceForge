use super::*;
use serde_json::json;

fn record(revision: &str) -> BrowserConfigurationRecord {
    BrowserConfigurationRecord {
        version: 7,
        values: json!({"token":"browser-raw-sentinel","nested":{"count":3}}),
        revision: revision.into(),
        applied: "defaults".into(),
        sensitive_paths: vec!["/token".into(), "/historical".into()],
    }
}

#[tokio::test]
async fn undeployed_record_survives_reopen_without_losing_raw_fields() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("user/plugin-configurations/browser");
    let store = FileBrowserConfigurations::open(&root).await.unwrap();
    assert!(store.get("bundled.example").await.unwrap().is_none());
    assert!(!root.join("bundled.example").exists());
    let legacy = record("defaults");
    assert_eq!(
        store
            .patch("bundled.example", None, legacy.clone())
            .await
            .unwrap(),
        legacy
    );
    let next = record(&uuid::Uuid::new_v4().to_string());
    store
        .patch("bundled.example", Some("defaults".into()), next.clone())
        .await
        .unwrap();
    let mut applied = next.clone();
    applied.applied = applied.revision.clone();
    // 应用状态更新保留现有修订，完整记录不能被存储端重建或遮蔽。
    store
        .patch("bundled.example", Some(next.revision), applied.clone())
        .await
        .unwrap();
    assert!(root.join("bundled.example/state.json").is_file());
    drop(store);
    let reopened = FileBrowserConfigurations::open(&root).await.unwrap();
    assert_eq!(
        reopened.get("bundled.example").await.unwrap(),
        Some(applied)
    );
}

#[tokio::test]
async fn null_and_stale_revisions_cannot_overwrite_an_existing_record() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    let initial = record(&uuid::Uuid::new_v4().to_string());
    assert!(matches!(
        store
            .patch("demo", Some("defaults".into()), initial.clone())
            .await,
        Err(Error::Conflict(_))
    ));
    store.patch("demo", None, initial.clone()).await.unwrap();
    for expected in [
        None,
        Some("defaults".into()),
        Some(uuid::Uuid::new_v4().to_string()),
    ] {
        assert!(matches!(
            store.patch("demo", expected, record("defaults")).await,
            Err(Error::Conflict(_))
        ));
    }
    assert_eq!(store.get("demo").await.unwrap(), Some(initial));
}

#[tokio::test]
async fn concurrent_updates_have_one_cas_winner() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    store.patch("demo", None, record("defaults")).await.unwrap();
    let left = store.patch(
        "demo",
        Some("defaults".into()),
        record(&uuid::Uuid::new_v4().to_string()),
    );
    let right = store.patch(
        "demo",
        Some("defaults".into()),
        record(&uuid::Uuid::new_v4().to_string()),
    );
    let (left, right) = tokio::join!(left, right);
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let loser = if left.is_ok() { right } else { left };
    assert!(matches!(loser, Err(Error::Conflict(_))));
}

#[tokio::test]
async fn validation_rejects_paths_bad_records_and_oversized_input_without_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    for id in ["../escape", "a/b", "a\\b", "builtin.demo", "", "UPPER"] {
        assert!(matches!(store.get(id).await, Err(Error::Invalid(_))));
        assert!(matches!(
            store.patch(id, None, record("defaults")).await,
            Err(Error::Invalid(_))
        ));
    }
    let mut zero_version = record("defaults");
    zero_version.version = 0;
    assert!(matches!(
        store.patch("demo", None, zero_version).await,
        Err(Error::Invalid(_))
    ));
    let mut invalid = record("bad-revision");
    assert!(matches!(
        store.patch("demo", None, invalid.clone()).await,
        Err(Error::Invalid(_))
    ));
    invalid.revision = "defaults".into();
    invalid.values = json!([]);
    assert!(matches!(
        store.patch("demo", None, invalid.clone()).await,
        Err(Error::Invalid(_))
    ));
    invalid.values = json!({});
    invalid.sensitive_paths = vec!["token".into()];
    assert!(matches!(
        store.patch("demo", None, invalid).await,
        Err(Error::Invalid(_))
    ));
    let mut oversized = record("defaults");
    oversized.values = json!({"large":"x".repeat(BROWSER_CONFIGURATION_LIMIT)});
    assert!(matches!(
        store.patch("demo", None, oversized).await,
        Err(Error::TooLarge)
    ));
    assert!(store.get("demo").await.unwrap().is_none());
    assert!(!temporary.path().join("demo").exists());
}

#[tokio::test]
async fn complete_record_exact_file_limit_is_accepted_and_one_more_byte_is_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    let mut boundary = record("defaults");
    boundary.values = json!({"large":""});
    let overhead = serde_json::to_vec(&boundary).unwrap().len();
    boundary.values["large"] = json!("x".repeat(BROWSER_CONFIGURATION_LIMIT - overhead));
    assert_eq!(
        serde_json::to_vec(&boundary).unwrap().len(),
        BROWSER_CONFIGURATION_LIMIT
    );
    store.patch("demo", None, boundary.clone()).await.unwrap();
    assert_eq!(store.get("demo").await.unwrap(), Some(boundary.clone()));
    boundary.values["large"] = json!("x".repeat(BROWSER_CONFIGURATION_LIMIT - overhead + 1));
    assert!(matches!(
        store.patch("demo", Some("defaults".into()), boundary).await,
        Err(Error::TooLarge)
    ));
    assert_eq!(
        fs::metadata(temporary.path().join("demo/state.json"))
            .unwrap()
            .len(),
        BROWSER_CONFIGURATION_LIMIT as u64
    );
}

#[tokio::test]
async fn corrupt_oversized_or_non_file_state_is_not_replaced() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    let directory = temporary.path().join("demo");
    fs::create_dir(&directory).unwrap();
    let path = directory.join("state.json");
    fs::write(&path, b"{").unwrap();
    assert!(matches!(store.get("demo").await, Err(Error::Invalid(_))));
    assert!(matches!(
        store.patch("demo", None, record("defaults")).await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), b"{");
    fs::write(&path, vec![b' '; BROWSER_CONFIGURATION_LIMIT + 1]).unwrap();
    assert!(matches!(store.get("demo").await, Err(Error::TooLarge)));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(store.get("demo").await, Err(Error::Invalid(_))));
}

#[tokio::test]
async fn second_store_is_locked_and_work_admission_is_bounded() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    assert!(matches!(
        FileBrowserConfigurations::open(temporary.path()).await,
        Err(Error::Conflict(_))
    ));
    let first = store.workers.clone().acquire_owned().await.unwrap();
    let second = store.workers.clone().acquire_owned().await.unwrap();
    assert!(matches!(store.get("demo").await, Err(Error::Conflict(_))));
    drop((first, second));
    assert!(store.get("demo").await.unwrap().is_none());
    drop(store);
    FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
}

#[tokio::test]
async fn another_process_cannot_open_a_store_until_the_owner_is_dropped() {
    let temporary = tempfile::tempdir().unwrap();
    let store = FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "browser_configurations::tests::cross_process_lock_probe",
            "--nocapture",
        ])
        .env("DEVICEFORGE_BROWSER_LOCK_TEST_ROOT", temporary.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "跨进程锁探针失败");
    assert!(String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"));
    drop(store);
    FileBrowserConfigurations::open(temporary.path())
        .await
        .unwrap();
}

#[test]
#[ignore = "仅由跨进程锁测试以隔离子进程调用"]
fn cross_process_lock_probe() {
    let root = std::env::var_os("DEVICEFORGE_BROWSER_LOCK_TEST_ROOT").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert!(matches!(
            FileBrowserConfigurations::open(Path::new(&root)).await,
            Err(Error::Conflict(_))
        ));
    });
}

#[cfg(unix)]
#[tokio::test]
async fn symbolic_directories_files_and_lock_are_rejected() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = temporary.path().join("browser");
    let store = FileBrowserConfigurations::open(&root).await.unwrap();
    symlink(outside.path(), root.join("demo")).unwrap();
    assert!(matches!(store.get("demo").await, Err(Error::Invalid(_))));
    assert!(matches!(
        store.patch("demo", None, record("defaults")).await,
        Err(Error::Invalid(_))
    ));
    fs::create_dir(root.join("file-link")).unwrap();
    fs::write(
        outside.path().join("state.json"),
        serde_json::to_vec(&record("defaults")).unwrap(),
    )
    .unwrap();
    symlink(
        outside.path().join("state.json"),
        root.join("file-link/state.json"),
    )
    .unwrap();
    assert!(matches!(
        store.get("file-link").await,
        Err(Error::Invalid(_))
    ));
    drop(store);
    fs::remove_file(root.join(".configurations.lock")).unwrap();
    symlink(
        outside.path().join("state.json"),
        root.join(".configurations.lock"),
    )
    .unwrap();
    assert!(matches!(
        FileBrowserConfigurations::open(&root).await,
        Err(Error::Invalid(_))
    ));
    symlink(outside.path(), temporary.path().join("root-link")).unwrap();
    assert!(matches!(
        FileBrowserConfigurations::open(&temporary.path().join("root-link")).await,
        Err(Error::Invalid(_))
    ));
}

#[cfg(windows)]
#[tokio::test]
async fn windows_directory_junction_cannot_escape_browser_root() {
    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = temporary.path().join("browser");
    let store = FileBrowserConfigurations::open(&root).await.unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(root.join("demo"))
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "测试目录联接创建失败");
    assert!(matches!(store.get("demo").await, Err(Error::Invalid(_))));
    assert!(matches!(
        store.patch("demo", None, record("defaults")).await,
        Err(Error::Invalid(_))
    ));
    assert!(!outside.path().join("state.json").exists());
    // 只移除本测试建立的联接，临时目录回收时不遍历外部目标。
    fs::remove_dir(root.join("demo")).unwrap();
}
