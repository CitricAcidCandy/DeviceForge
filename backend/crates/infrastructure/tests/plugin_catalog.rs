use apk_domain::{Error, Executor, plugins::PluginCatalog};
use apk_infrastructure::{artifacts::FileArtifacts, plugin_catalog::FilePluginCatalog};
use serde_json::json;
use std::{path::Path, sync::Arc};

async fn catalog(root: &Path) -> FilePluginCatalog {
    let artifacts = Arc::new(FileArtifacts::open(&root.join(".artifacts")).await.unwrap());
    FilePluginCatalog::open(root, artifacts).await.unwrap()
}
fn deploy(root: &Path, directory: &str, id: &str) {
    let path = root.join(directory);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join("manifest.json"),
        serde_json::to_vec(&json!({
            "id":id,"version":"1.0.0","protocol_version":1,
            "executable":std::env::current_exe().unwrap(),"args":[],
            "operations":[{"name":"echo","title":"测试贡献","input_schema":{"type":"object"}}]
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn initial_ignores_staging_and_loads_sorted_identity_checked_plugins() {
    let root = tempfile::tempdir().unwrap();
    deploy(root.path(), "zeta", "zeta");
    deploy(root.path(), "alpha", "alpha");
    std::fs::create_dir(root.path().join(".installing")).unwrap();
    std::fs::write(root.path().join("readme.txt"), "普通文件不参与加载").unwrap();
    let catalog = catalog(root.path()).await;
    let initial = catalog.initial().await.unwrap();
    assert_eq!(
        initial
            .iter()
            .map(|p| p.manifest().id.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "zeta"]
    );
    assert_eq!(
        catalog.load("alpha").await.unwrap().executor.operations()[0].id,
        "plugin.alpha.echo"
    );
}

#[tokio::test]
async fn unsafe_ids_missing_mismatched_and_oversized_manifests_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let catalog = catalog(root.path()).await;
    for id in ["../outside", "", "builtin.adb", "Bad", "a/b", "a\\b"] {
        assert!(matches!(catalog.load(id).await, Err(Error::Invalid(_))));
    }
    assert!(matches!(
        catalog.load("missing").await,
        Err(Error::NotFound(_))
    ));
    deploy(root.path(), "wrong", "different");
    assert!(matches!(
        catalog.load("wrong").await,
        Err(Error::Invalid(_))
    ));
    deploy(root.path(), "large", "large");
    std::fs::write(root.path().join("large/manifest.json"), vec![b' '; 65537]).unwrap();
    assert!(matches!(catalog.load("large").await, Err(Error::TooLarge)));
    deploy(root.path(), "broken", "broken");
    std::fs::write(root.path().join("broken/manifest.json"), "{").unwrap();
    assert!(matches!(
        catalog.load("broken").await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn initial_scan_has_a_bound_even_when_all_entries_are_hidden() {
    let root = tempfile::tempdir().unwrap();
    let catalog = catalog(root.path()).await;
    for index in 0..1025 {
        std::fs::write(root.path().join(format!(".staging-{index}")), []).unwrap();
    }
    assert!(matches!(catalog.initial().await, Err(Error::TooLarge)));
}

#[tokio::test]
async fn linked_directory_and_linked_manifest_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    deploy(outside.path(), "linked", "linked");
    let catalog = catalog(root.path()).await;
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(
        outside.path().join("linked"),
        root.path().join("linked"),
    );
    #[cfg(unix)]
    let linked =
        std::os::unix::fs::symlink(outside.path().join("linked"), root.path().join("linked"));
    if let Err(error) = linked {
        panic!("本测试需要系统允许创建符号链接：{error}");
    }
    assert!(matches!(
        catalog.load("linked").await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(catalog.initial().await, Err(Error::Invalid(_))));
    deploy(root.path(), "manifest_link", "manifest_link");
    let path = root.path().join("manifest_link/manifest.json");
    std::fs::remove_file(&path).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(outside.path().join("linked/manifest.json"), &path).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("linked/manifest.json"), &path).unwrap();
    assert!(matches!(
        catalog.load("manifest_link").await,
        Err(Error::Invalid(_))
    ));
}

fn display(id: &str, version: &str, name: &str) -> serde_json::Value {
    json!({
        "metadata_version": 1, "id": id, "version": version,
        "name": name, "summary": "管理设备连接和应用", "description": "通过插件提供设备能力。",
        "kind": "plugin", "details": {"plugin_kind": "server"}
    })
}

#[tokio::test]
async fn initial_and_hot_load_publish_identity_checked_local_display_metadata() {
    let root = tempfile::tempdir().unwrap();
    deploy(root.path(), "device", "device");
    let path = root.path().join("device/market.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&display("device", "1.0.0", "设备管理")).unwrap(),
    )
    .unwrap();
    let catalog = catalog(root.path()).await;
    let initial = catalog.initial().await.unwrap();
    let first = initial[0].plugin_metadata().unwrap();
    assert_eq!(first.name, "设备管理");
    assert_eq!(first.summary, "管理设备连接和应用");
    assert_eq!(first.description, "通过插件提供设备能力。");
    std::fs::write(
        &path,
        serde_json::to_vec(&display("device", "1.0.0", "设备工具")).unwrap(),
    )
    .unwrap();
    let loaded = catalog.load("device").await.unwrap();
    assert_eq!(loaded.executor.plugin_metadata().unwrap().name, "设备工具");
    assert_eq!(initial[0].plugin_metadata().unwrap().name, "设备管理");
    assert_eq!(loaded.executor.operations()[0].id, "plugin.device.echo");
}

#[tokio::test]
async fn missing_invalid_and_oversized_display_metadata_do_not_block_plugin_loading() {
    let root = tempfile::tempdir().unwrap();
    deploy(root.path(), "device", "device");
    let catalog = catalog(root.path()).await;
    assert!(
        catalog
            .load("device")
            .await
            .unwrap()
            .executor
            .plugin_metadata()
            .is_none()
    );
    assert!(
        catalog.initial().await.unwrap()[0]
            .plugin_metadata()
            .is_none()
    );
    let path = root.path().join("device/market.json");
    let mut empty = display("device", "1.0.0", "设备管理");
    empty["name"] = json!("  ");
    let mut missing = display("device", "1.0.0", "设备管理");
    missing.as_object_mut().unwrap().remove("description");
    let mut unsupported = display("device", "1.0.0", "设备管理");
    unsupported["metadata_version"] = json!(2);
    for bytes in [
        b"{".to_vec(),
        vec![b' '; 65537],
        serde_json::to_vec(&display("another", "1.0.0", "设备管理")).unwrap(),
        serde_json::to_vec(&display("device", "2.0.0", "设备管理")).unwrap(),
        serde_json::to_vec(&display("device", "1.0.0", &"a".repeat(201))).unwrap(),
        serde_json::to_vec(&empty).unwrap(),
        serde_json::to_vec(&missing).unwrap(),
        serde_json::to_vec(&unsupported).unwrap(),
    ] {
        std::fs::write(&path, bytes).unwrap();
        let plugin = catalog.load("device").await.unwrap();
        assert!(plugin.executor.plugin_metadata().is_none());
        assert_eq!(plugin.executor.operations()[0].id, "plugin.device.echo");
    }
}

#[tokio::test]
async fn directory_and_linked_display_metadata_are_ignored_without_reading_external_text() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    deploy(root.path(), "directory", "directory");
    deploy(root.path(), "linked", "linked");
    std::fs::create_dir(root.path().join("directory/market.json")).unwrap();
    let foreign = outside.path().join("market.json");
    std::fs::write(
        &foreign,
        serde_json::to_vec(&display("linked", "1.0.0", "外部资料")).unwrap(),
    )
    .unwrap();
    let linked = root.path().join("linked/market.json");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&foreign, &linked).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&foreign, &linked).unwrap();
    let catalog = catalog(root.path()).await;
    for id in ["directory", "linked"] {
        assert!(
            catalog
                .load(id)
                .await
                .unwrap()
                .executor
                .plugin_metadata()
                .is_none()
        );
    }
    assert!(
        catalog
            .initial()
            .await
            .unwrap()
            .iter()
            .all(|plugin| plugin.plugin_metadata().is_none())
    );
}
