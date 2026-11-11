//! 大清单须贯通离线安装、活动视图更新和目录加载；夹具入口从不执行。
use super::*;
use apk_domain::plugins::PluginCatalog;

const FIVE_MIB: usize = 5 * 1024 * 1024;
const LARGE_DESCRIPTION: usize = 4 * 1024 * 1024 + 512 * 1024;

#[test]
fn generated_installation_manifest_over_limit_does_not_replace_previous_file() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("manifest.json");
    fs::write(&target, b"previous").unwrap();
    let value = json!({"description":"x".repeat(FIVE_MIB)});
    let actual = serde_json::to_vec(&value).unwrap().len();
    let error = paths::write_bounded(&target, &value, FIVE_MIB).unwrap_err();
    assert_eq!(error.code(), "payload_too_large");
    let message = error.to_string();
    for expected in [
        "manifest.json".to_owned(),
        actual.to_string(),
        FIVE_MIB.to_string(),
    ] {
        assert!(message.contains(&expected), "{message}");
    }
    assert_eq!(fs::read(&target).unwrap(), b"previous");
}

fn release_with_manifest(
    kind: PackageKind,
    version: &str,
    description_bytes: usize,
) -> (Vec<u8>, usize, &'static str) {
    let description = "x".repeat(description_bytes);
    let (id, runtime, entry, manifest) = match kind {
        PackageKind::Server => (
            "large_manifest_server",
            "native",
            "entry.bin",
            json!({"id":"large_manifest_server","version":version,"protocol_version":1,
                "operations":[{"name":"inspect","title":"只读夹具", "input_schema":{
                    "type":"object","description":description}}]}),
        ),
        PackageKind::Browser => (
            "large_manifest_browser",
            "browser",
            "entry.js",
            json!({"id":"large_manifest_browser","version":version,"api_version":2,
                "configuration":{"version":1,"defaults":{},"schema":{
                    "type":"object","description":description}}}),
        ),
    };
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let manifest_size = manifest_bytes.len();
    let component = zip(vec![
        (
            "package.json",
            serde_json::to_vec(&json!({"version":version,"deviceforge":{
                "kind":kind,"manifest":"plugin.json","entrypoints":{
                    "any":{"runtime":runtime,"path":entry}}}}))
            .unwrap(),
        ),
        ("plugin.json", manifest_bytes),
        (entry, b"fixture-only-no-execution".to_vec()),
    ]);
    let digest = format!("{:x}", Sha256::digest(&component));
    let path = format!("blobs/{digest}");
    let release = json!({"format_version":2,"host_api_version":2,
        "id":"large_manifest_release","version":version,
        "name":"大清单回归","description":"验证清单预算及错误边界",
        "components":[{"id":id,"kind":kind,"version":version,"variants":[{
            "platform":"any","path":path,"sha256":digest,"size":component.len(),"format":"zip"}]}],
        "dependencies":{"format_version":1,"dependencies":[]}});
    (
        zip(vec![
            ("release.json", serde_json::to_vec(&release).unwrap()),
            (&path, component),
        ]),
        manifest_size,
        id,
    )
}

#[tokio::test]
async fn large_server_manifest_installs_updates_and_loads_without_starting_process() {
    let (_directory, artifacts, store) = setup().await;
    let (bytes, manifest_size, id) =
        release_with_manifest(PackageKind::Server, "1.0.0", LARGE_DESCRIPTION);
    assert!(manifest_size > 65_536 && manifest_size < FIVE_MIB);
    let first = store
        .prepare(upload(&artifacts, bytes).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    store
        .set_enabled(&first.id, &first.revision, true)
        .await
        .unwrap();
    // 仅在存储夹具中登记既有激活结果，不启动插件；验证两份大清单历史仍可读取。
    store
        .record_successful_activation(&first.id, &first.revision)
        .await
        .unwrap();
    let (bytes, _, _) = release_with_manifest(PackageKind::Server, "1.0.1", LARGE_DESCRIPTION);
    let updated = store
        .prepare(upload(&artifacts, bytes).await)
        .await
        .unwrap()
        .commit(Some(first.revision.clone()))
        .await
        .unwrap();
    assert_ne!(first.revision, updated.revision);
    store
        .set_enabled(&updated.id, &updated.revision, true)
        .await
        .unwrap();
    store
        .record_successful_activation(&updated.id, &updated.revision)
        .await
        .unwrap();
    let previous = store
        .previous_successful(&updated.id, &updated.revision)
        .await
        .unwrap();
    assert_eq!(previous.release.revision, first.revision);
    let active = storage::component_root(&store.root, PackageKind::Server, id);
    assert!(fs::metadata(active.join("manifest.json")).unwrap().len() > 65_536);
    let catalog =
        crate::plugin_catalog::FilePluginCatalog::open(&store.root.join("plugins"), artifacts)
            .await
            .unwrap();
    let contribution = catalog.load(id).await.unwrap();
    assert_eq!(contribution.id, id);
    assert_eq!(contribution.version, "1.0.1");
    let operations = contribution.executor.operations();
    assert_eq!(operations.len(), 1);
    assert_eq!(
        operations[0].input_schema["description"]
            .as_str()
            .unwrap()
            .len(),
        LARGE_DESCRIPTION
    );
}

#[tokio::test]
async fn large_browser_manifest_preserves_schema_through_prepare_and_commit() {
    let (_directory, artifacts, store) = setup().await;
    let (bytes, manifest_size, id) =
        release_with_manifest(PackageKind::Browser, "1.0.0", 96 * 1024);
    assert!(manifest_size > 65_536 && manifest_size < FIVE_MIB);
    let installed = store
        .prepare(upload(&artifacts, bytes).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let asset = store
        .asset(id, &installed.revision, "plugin.json")
        .await
        .unwrap();
    let actual = asset.stream.try_collect::<Vec<_>>().await.unwrap().concat();
    assert_eq!(actual.len(), manifest_size);
    let manifest: serde_json::Value = serde_json::from_slice(&actual).unwrap();
    assert_eq!(
        manifest["configuration"]["schema"]["description"]
            .as_str()
            .unwrap()
            .len(),
        96 * 1024
    );
    assert_eq!(installed.components[0].id, id);
}

#[tokio::test]
async fn oversized_component_manifest_reports_component_file_actual_and_limit_without_host_path() {
    for kind in [PackageKind::Server, PackageKind::Browser] {
        let (directory, artifacts, store) = setup().await;
        let (bytes, manifest_size, id) = release_with_manifest(kind, "1.0.0", FIVE_MIB + 1);
        let error = match store.prepare(upload(&artifacts, bytes).await).await {
            Ok(_) => panic!("超过5MiB的插件清单不应通过安装准备"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "payload_too_large");
        let message = error.to_string();
        for expected in [
            id.to_owned(),
            "plugin.json".to_owned(),
            manifest_size.to_string(),
            FIVE_MIB.to_string(),
            "字节".to_owned(),
        ] {
            assert!(message.contains(&expected), "错误缺少{expected}：{message}");
        }
        assert!(!message.contains(directory.path().to_string_lossy().as_ref()));
        assert!(!message.contains(&store.root.to_string_lossy().to_string()));
        assert!(store.list().await.unwrap().is_empty());
        assert!(
            !storage::component_root(&store.root, kind, id)
                .join("manifest.json")
                .exists()
        );
    }
}
