use super::*;

#[tokio::test]
async fn publication_failure_restores_the_old_directory_and_manifest() {
    let directory = tempfile::tempdir().unwrap();
    let store = FilePluginPackages::open(
        &directory.path().join("server"),
        &directory.path().join("browser"),
        None,
    )
    .await
    .unwrap();
    let root = store.root(PackageKind::Browser);
    let destination = root.path.join("rollback_demo");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("entry.js"), "旧包原字节").unwrap();
    let mut info = PackageInfo {
        kind: PackageKind::Browser,
        id: "rollback_demo".into(),
        version: "1.0.0".into(),
        runtime: "browser".into(),
        entry_path: "entry.js".into(),
        entry_url: None,
        api_version: Some(2),
        installed_at: 0,
    };
    storage::write_info(&destination, &info).unwrap();
    info.version = "2.0.0".into();
    // 模拟已验证暂存随后不可发布，强制进入旧包已移出后的回滚分支。
    let staged = tempfile::Builder::new()
        .prefix(".package-")
        .tempdir_in(&root.path)
        .unwrap();
    let prepared = Prepared {
        staging: Staging {
            directory: Some(staged),
            upload: None,
        },
        root: root.clone(),
        info,
        operations: vec![],
        workers: store.workers.clone(),
    };
    assert!(matches!(storage::replace(prepared), Err(Error::Storage(_))));
    assert_eq!(
        fs::read_to_string(destination.join("entry.js")).unwrap(),
        "旧包原字节"
    );
    assert_eq!(
        storage::list(&root, PackageKind::Browser).unwrap()[0].version,
        "1.0.0"
    );
}
