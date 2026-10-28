//! 成功版本独立于事务前版；恢复只切代码视图，不覆盖业务数据和配置。
use super::*;

async fn install_version(
    store: &Arc<FilePluginInstallations>,
    artifacts: &Arc<dyn ArtifactStore>,
    version: &str,
    expected: Option<String>,
) -> InstalledRelease {
    let source = upload(artifacts, release_bytes(version, b"shared-tool", false)).await;
    store
        .prepare(source)
        .await
        .unwrap()
        .commit(expected)
        .await
        .unwrap()
}
async fn successful(store: &Arc<FilePluginInstallations>, release: &InstalledRelease) {
    store
        .set_enabled(&release.id, &release.revision, true)
        .await
        .unwrap();
    store
        .record_successful_activation(&release.id, &release.revision)
        .await
        .unwrap();
}

#[tokio::test]
async fn successful_restore_skips_unactivated_previous_and_preserves_disabled_intent_and_business_data()
 {
    let (_directory, artifacts, store) = setup().await;
    let first = install_version(&store, &artifacts, "1.0.0", None).await;
    // 单纯安装、启用状态与旧 previous 快照均不能替代成功激活证据。
    assert!(
        store
            .previous_successful(&first.id, &first.revision)
            .await
            .is_err()
    );
    successful(&store, &first).await;
    let unactivated =
        install_version(&store, &artifacts, "2.0.0", Some(first.revision.clone())).await;
    let current = install_version(
        &store,
        &artifacts,
        "3.0.0",
        Some(unactivated.revision.clone()),
    )
    .await;
    store
        .set_enabled(&current.id, &current.revision, false)
        .await
        .unwrap();
    let data_dir = paths::create_directory(&store.root, "plugin-data/sample_browser").unwrap();
    fs::write(data_dir.join("state.json"), b"business-sentinel").unwrap();
    let config_dir =
        paths::create_directory(&store.root, "plugin-configurations/browser/sample_browser")
            .unwrap();
    fs::write(config_dir.join("state.json"), b"config-sentinel").unwrap();
    let previous = store
        .previous_successful(&current.id, &current.revision)
        .await
        .unwrap();
    assert_eq!(previous.release.revision, first.revision);
    assert_eq!(previous.scope, SuccessfulReleaseScope::HostActivation);
    let restored = store
        .restore_previous_successful(
            &current.id,
            &current.revision,
            &previous.release.revision,
            apk_domain::ExecutionContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(restored.revision, first.revision);
    assert!(!restored.enabled);
    assert_eq!(restored.status, InstallationStatus::Installed);
    assert_eq!(
        fs::read(data_dir.join("state.json")).unwrap(),
        b"business-sentinel"
    );
    assert_eq!(
        fs::read(config_dir.join("state.json")).unwrap(),
        b"config-sentinel"
    );
    assert!(
        store
            .restore_previous_successful(
                &current.id,
                &current.revision,
                &first.revision,
                Default::default()
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn successful_restore_rejects_foreign_component_owner_corruption_and_expired_deadline_before_write()
 {
    let (_directory, artifacts, store) = setup().await;
    let first = install_version(&store, &artifacts, "1.0.0", None).await;
    successful(&store, &first).await;
    let current = install_version(&store, &artifacts, "2.0.0", Some(first.revision.clone())).await;
    assert!(
        store
            .restore_previous_successful(
                &current.id,
                &current.revision,
                &first.revision,
                apk_domain::ExecutionContext {
                    deadline: Some(std::time::Instant::now())
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get(&current.id).await.unwrap().revision,
        current.revision
    );
    let mut other = first.clone();
    other.id = "foreign_release".into();
    paths::write(&storage::record_path(&store.root, &other.id), &other).unwrap();
    assert!(
        store
            .restore_previous_successful(
                &current.id,
                &current.revision,
                &first.revision,
                Default::default()
            )
            .await
            .is_err()
    );
    fs::remove_file(storage::record_path(&store.root, &other.id)).unwrap();
    let root = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    fs::write(
        root.join("revisions")
            .join(&first.revision)
            .join("dist/index.js"),
        b"corrupt",
    )
    .unwrap();
    assert!(
        store
            .restore_previous_successful(
                &current.id,
                &current.revision,
                &first.revision,
                Default::default()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get(&current.id).await.unwrap().revision,
        current.revision
    );
}

#[tokio::test]
async fn successful_history_survives_restart_and_resource_cleanup_protects_successful_code_and_tools()
 {
    let (directory, artifacts, store) = setup().await;
    let first = install_version(&store, &artifacts, "1.0.0", None).await;
    successful(&store, &first).await;
    let second = install_version(&store, &artifacts, "2.0.0", Some(first.revision.clone())).await;
    let current = install_version(&store, &artifacts, "3.0.0", Some(second.revision)).await;
    store.cleanup_resources(false, vec![]).await.unwrap();
    let root = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    assert!(root.join("revisions").join(&first.revision).exists());
    drop(store);
    let reopened = FilePluginInstallations::open(&directory.path().join("user"), artifacts, None)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .previous_successful(&current.id, &current.revision)
            .await
            .unwrap()
            .release
            .revision,
        first.revision
    );
}
