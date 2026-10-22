use super::*;
use apk_domain::plugin_packages::PackageKind;
use futures_util::{TryStreamExt, stream};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Write};

#[test]
fn immutable_inventory_detects_mutation_and_extra_file() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("payload"), b"original").unwrap();
    content::seal(root.path()).unwrap();
    content::verify(root.path()).unwrap();
    fs::write(root.path().join("extra"), b"unexpected").unwrap();
    assert!(content::verify(root.path()).is_err());
    fs::remove_file(root.path().join("extra")).unwrap();
    fs::write(root.path().join("payload"), b"changed").unwrap();
    assert!(content::verify(root.path()).is_err());
}

#[test]
fn install_paths_reject_traversal_and_file_as_parent() {
    let root = tempfile::tempdir().unwrap();
    let root = paths::open_root(root.path()).unwrap();
    fs::write(root.join("ordinary"), b"content").unwrap();
    assert!(paths::existing(&root, "../ordinary").is_err());
    assert!(paths::create_directory(&root, "ordinary/child").is_err());
}

#[test]
fn user_directory_lock_is_exclusive() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("lock");
    let lock = paths::lock(&path).unwrap();
    assert!(paths::lock(&path).is_err());
    drop(lock);
    paths::lock(&path).unwrap();
}

fn zip(files: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&bytes).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn release_bytes(version: &str, tool: &[u8], corrupt_tool: bool) -> Vec<u8> {
    let package = zip(vec![
        ("package.json", serde_json::to_vec(&json!({"version":version,"deviceforge":{"kind":"browser","manifest":"browser.json","entrypoints":{"any":{"runtime":"browser","path":"dist/index.js"}}}})).unwrap()),
        ("browser.json", serde_json::to_vec(&json!({"id":"sample_browser","version":version,"api_version":2})).unwrap()),
        ("dist/index.js", format!("export const version = '{version}';").into_bytes()),
        ("dist/data.json", br#"{"unchanged":true}"#.to_vec()),
    ]);
    let manifest = json!({"format_version":1,"host_api_version":2,"id":"sample_release","version":version,"name":"样例功能","description":"统一离线安装测试功能",
        "components":[{"id":"sample_browser","kind":"browser","version":version,"variants":[{"platform":"any","path":"components/browser.zip","sha256":format!("{:x}",Sha256::digest(&package)),"size":package.len(),"format":"zip"}]}],
        "tools":[{"id":"sample_helper","version":"1.0","variants":[{"platform":"any","path":"tools/helper.bin","sha256":format!("{:x}",Sha256::digest(tool)),"size":tool.len(),"format":"file","entries":{"executable":"payload"}}],"bindings":[{"component_id":"sample_browser","config_pointer":"/helper","entry":"executable"}]}]
    });
    zip(vec![
        ("release.json", serde_json::to_vec(&manifest).unwrap()),
        ("components/browser.zip", package),
        (
            "tools/helper.bin",
            if corrupt_tool {
                b"bad-tool".to_vec()
            } else {
                tool.to_vec()
            },
        ),
    ])
}

async fn setup() -> (
    tempfile::TempDir,
    Arc<dyn ArtifactStore>,
    Arc<FilePluginInstallations>,
) {
    let directory = tempfile::tempdir().unwrap();
    let artifacts: Arc<dyn ArtifactStore> = Arc::new(
        crate::artifacts::FileArtifacts::open(directory.path().join("uploads"))
            .await
            .unwrap(),
    );
    let store =
        FilePluginInstallations::open(&directory.path().join("user"), artifacts.clone(), None)
            .await
            .unwrap();
    (directory, artifacts, store)
}

async fn upload(artifacts: &Arc<dyn ArtifactStore>, bytes: Vec<u8>) -> InstallSource {
    let artifact = artifacts
        .put(
            "release.zip".into(),
            Box::pin(stream::once(async move { Ok(bytes.into()) })),
        )
        .await
        .unwrap();
    InstallSource::Offline {
        artifact_id: artifact.id,
    }
}

#[tokio::test]
async fn offline_update_preserves_config_tools_and_previous_browser_bytes() {
    let (_directory, artifacts, store) = setup().await;
    let config =
        paths::create_directory(&store.root, "plugin-configurations/browser/sample_browser")
            .unwrap()
            .join("state.json");
    fs::write(&config, b"configuration-sentinel").unwrap();
    let source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let plan = store.plan(source.clone()).await.unwrap();
    assert_eq!(plan.resources.len(), 2);
    assert!(plan.download_size > 0);
    let first = store
        .prepare(source.clone())
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let cached_plan = store.plan(source).await.unwrap();
    assert_eq!(cached_plan.download_size, 0);
    assert!(cached_plan.resources.iter().all(|resource| resource.reused));
    let response = store
        .asset("sample_browser", &first.revision, "dist/data.json")
        .await
        .unwrap();
    let chunks = response.stream.try_collect::<Vec<_>>().await.unwrap();
    assert_eq!(chunks.concat(), br#"{"unchanged":true}"#);
    assert!(
        store
            .asset("sample_browser", &first.revision, "resources.json")
            .await
            .is_err()
    );
    let active = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    let metadata: serde_json::Value = paths::read(&active.join("market.json"), 65_536).unwrap();
    assert_eq!(metadata["metadata_version"], 1);
    assert_eq!(metadata["name"], "样例功能");
    let second_source = upload(&artifacts, release_bytes("2.0.0", b"shared-tool", false)).await;
    let second_plan = store.plan(second_source.clone()).await.unwrap();
    assert!(
        second_plan
            .resources
            .iter()
            .any(|resource| resource.kind == "tool" && resource.reused)
    );
    let second = store
        .prepare(second_source)
        .await
        .unwrap()
        .commit(Some(first.revision.clone()))
        .await
        .unwrap();
    assert_ne!(first.revision, second.revision);
    assert!(
        active
            .join("revisions")
            .join(&first.revision)
            .join("dist/index.js")
            .exists()
    );
    assert_eq!(fs::read(&config).unwrap(), b"configuration-sentinel");
    let restored = store
        .restore_previous("sample_release", &second.revision)
        .await
        .unwrap();
    assert_eq!(restored.revision, first.revision);
    assert!(
        store
            .asset("sample_browser", &second.revision, "dist/index.js")
            .await
            .is_ok()
    );
    store
        .delete("sample_release", &first.revision)
        .await
        .unwrap();
    assert!(!active.join("manifest.json").exists());
    assert!(active.join("revisions").join(&first.revision).exists());
    assert_eq!(fs::read(config).unwrap(), b"configuration-sentinel");
    assert!(store.root.join("tools/sample_helper/1.0").is_dir());
}

#[tokio::test]
async fn corrupt_resource_and_stale_revision_leave_active_release_untouched() {
    let (_directory, artifacts, store) = setup().await;
    let broken = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", true)).await;
    assert!(store.prepare(broken).await.is_err());
    assert!(store.list().await.unwrap().is_empty());
    let first_source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let first = store
        .prepare(first_source)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let new_source = upload(&artifacts, release_bytes("2.0.0", b"shared-tool", false)).await;
    let prepared = store.prepare(new_source).await.unwrap();
    assert!(prepared.commit(Some("f".repeat(64))).await.is_err());
    assert_eq!(
        store.get("sample_release").await.unwrap().revision,
        first.revision
    );
    let active = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    let manifest: serde_json::Value = paths::read(&active.join("manifest.json"), 65_536).unwrap();
    assert_eq!(manifest["version"], "1.0.0");
}

#[tokio::test]
async fn same_version_cannot_rebind_tool_digest_after_release_removal() {
    let (_directory, artifacts, store) = setup().await;
    let first_source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let first = store
        .prepare(first_source)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    store
        .delete("sample_release", &first.revision)
        .await
        .unwrap();
    let changed_source = upload(&artifacts, release_bytes("2.0.0", b"replaced-tool", false)).await;
    let plan = store.plan(changed_source.clone()).await.unwrap();
    assert!(
        plan.issues
            .iter()
            .any(|issue| issue.code == "version_conflict" && issue.required)
    );
    assert!(matches!(
        store.prepare(changed_source).await,
        Err(Error::Conflict(_))
    ));
}

#[test]
fn market_urls_reject_credentials_and_other_protocols() {
    assert!(fetch::url("https://user:password@example.com/release.json").is_err());
    assert!(fetch::url("file:///release.json").is_err());
    assert!(fetch::url("https://example.com/release.json#fragment").is_err());
    assert!(fetch::url("http://127.0.0.1/release.json").is_ok());
}
