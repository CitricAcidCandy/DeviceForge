use super::*;
use apk_domain::{plugin_installations::*, plugin_packages::PackageKind};
use futures_util::{TryStreamExt, stream};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Write};
mod local_rebuild;
mod successful;

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
    release_bytes_with_tool_version(version, "1.0", tool, corrupt_tool)
}

fn release_bytes_with_tool_version(
    version: &str,
    tool_version: &str,
    tool: &[u8],
    corrupt_tool: bool,
) -> Vec<u8> {
    let package = zip(vec![
        ("package.json", serde_json::to_vec(&json!({"version":version,"deviceforge":{"kind":"browser","manifest":"browser.json","entrypoints":{"any":{"runtime":"browser","path":"dist/index.js"}}}})).unwrap()),
        ("browser.json", serde_json::to_vec(&json!({"id":"sample_browser","version":version,"api_version":2})).unwrap()),
        ("dist/index.js", format!("export const version = '{version}';").into_bytes()),
        ("dist/data.json", br#"{"unchanged":true}"#.to_vec()),
    ]);
    let manifest = json!({"format_version":1,"host_api_version":2,"id":"sample_release","version":version,"name":"样例功能","description":"统一离线安装测试功能",
        "components":[{"id":"sample_browser","kind":"browser","version":version,"variants":[{"platform":"any","path":"components/browser.zip","sha256":format!("{:x}",Sha256::digest(&package)),"size":package.len(),"format":"zip"}]}],
        "tools":[{"id":"sample_helper","version":tool_version,"variants":[{"platform":"any","path":"tools/helper.bin","sha256":format!("{:x}",Sha256::digest(tool)),"size":tool.len(),"format":"file","entries":{"executable":"payload"}}],"bindings":[{"component_id":"sample_browser","config_pointer":"/helper","entry":"executable"}]}]
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
    setup_with_sources(Vec::new()).await
}

async fn setup_with_sources(
    sources: Vec<String>,
) -> (
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
    let store = FilePluginInstallations::open_with_sources(
        &directory.path().join("user"),
        artifacts.clone(),
        None,
        sources,
    )
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

#[tokio::test]
async fn market_sources_require_same_origin_and_directory_boundary() {
    let (directory, artifacts, store) = setup().await;
    let target = fetch::url("https://market.example/catalog/releases/a/release.json").unwrap();
    assert!(store.validate_market_url(&target).is_err());
    let store = FilePluginInstallations::open_with_sources(
        &directory.path().join("trusted-user"),
        artifacts,
        None,
        vec![
            "https://market.example/catalog".into(),
            "https://market.example/with-slash/".into(),
        ],
    )
    .await
    .unwrap();
    assert!(store.validate_market_url(&target).is_ok());
    assert!(
        store
            .validate_market_url(
                &fetch::url("https://market.example/with-slash/release.json").unwrap()
            )
            .is_ok()
    );
    assert!(
        store
            .validate_market_url(&fetch::url("https://market.example/release.json").unwrap())
            .is_err()
    );
    assert!(
        store
            .validate_market_url(
                &fetch::url("https://market.example/catalog-other/release.json").unwrap()
            )
            .is_err()
    );
    assert!(
        store
            .validate_market_url(&fetch::url("https://other.example/catalog/release.json").unwrap())
            .is_err()
    );
}

#[tokio::test]
async fn recovery_block_preserves_enabled_intent_and_rejects_lifecycle_changes() {
    let (_directory, artifacts, store) = setup().await;
    let source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let installed = store
        .prepare(source)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    assert!(installed.enabled);
    let blocked = store
        .recovery_blocked(
            &installed.id,
            &installed.revision,
            "transaction_rollback_cleanup",
            "测试清理失败",
        )
        .await
        .unwrap();
    assert!(blocked.enabled);
    assert_eq!(blocked.status, InstallationStatus::RecoveryBlocked);
    assert_eq!(
        blocked.failure.unwrap().phase,
        "transaction_rollback_cleanup"
    );
    assert!(
        store
            .set_enabled(&installed.id, &installed.revision, false)
            .await
            .is_err()
    );
    assert!(
        store
            .delete(&installed.id, &installed.revision)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn old_component_cleanup_warning_allows_retry_delete_and_update_without_erasing_diagnosis() {
    for update in [false, true] {
        let (_directory, artifacts, store) = setup().await;
        let source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
        let installed = store
            .prepare(source)
            .await
            .unwrap()
            .commit(None)
            .await
            .unwrap();
        let blocked = store
            .recovery_blocked(
                &installed.id,
                &installed.revision,
                "component_cleanup",
                "历史组件清理告警",
            )
            .await
            .unwrap();
        assert!(!blocked.requires_recovery());
        if update {
            let next = upload(&artifacts, release_bytes("2.0.0", b"shared-tool", false)).await;
            let upgraded = store
                .prepare(next)
                .await
                .unwrap()
                .commit(Some(installed.revision))
                .await
                .unwrap();
            assert_eq!(upgraded.version, "2.0.0");
        } else {
            let disabled = store
                .set_enabled(&installed.id, &installed.revision, false)
                .await
                .unwrap();
            assert_eq!(disabled.status, InstallationStatus::Installed);
            assert!(!disabled.enabled);
            assert_eq!(disabled.failure.unwrap().phase, "component_cleanup");
            store
                .delete(&installed.id, &installed.revision)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn cleanup_protects_current_previous_and_running_versions() {
    let (_directory, artifacts, store) = setup().await;
    let mut versions = Vec::new();
    for version in ["1.0.0", "2.0.0", "3.0.0"] {
        let source = upload(&artifacts, release_bytes(version, b"shared-tool", false)).await;
        let expected = versions
            .last()
            .map(|record: &InstalledRelease| record.revision.clone());
        versions.push(
            store
                .prepare(source)
                .await
                .unwrap()
                .commit(expected)
                .await
                .unwrap(),
        );
        let idle = store
            .installations
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        drop(idle);
    }
    let first_path = format!(
        "browser-plugins/sample_browser/revisions/{}",
        versions[0].revision
    );
    let dry = store.cleanup_resources(true, vec![]).await.unwrap();
    assert!(dry.items.iter().any(|item| item.resource == first_path));
    assert!(store.root.join(&first_path).exists());
    let busy = store
        .cleanup_resources(true, vec!["sample_browser".into()])
        .await
        .unwrap();
    assert!(!busy.items.iter().any(|item| item.resource == first_path));
    let deleted = store.cleanup_resources(false, vec![]).await.unwrap();
    assert!(deleted.items.iter().any(|item| item.resource == first_path));
    assert!(!store.root.join(first_path).exists());
    for release in &versions[1..] {
        assert!(
            store
                .root
                .join(format!(
                    "browser-plugins/sample_browser/revisions/{}",
                    release.revision
                ))
                .is_dir()
        );
    }
    assert_eq!(
        store
            .cleanup_resources(true, vec![])
            .await
            .unwrap()
            .total_bytes,
        0
    );
}

#[tokio::test]
async fn cancelling_file_work_keeps_staging_lease_until_worker_finishes() {
    let (_directory, _artifacts, store) = setup().await;
    let directory = tempfile::tempdir_in(store.root.join("installations/staging")).unwrap();
    let path = directory.path().to_owned();
    let stage = Stage(Arc::new(StageLease {
        directory: Some(directory),
        permit: Some(
            store
                .installations
                .clone()
                .acquire_many_owned(2)
                .await
                .unwrap(),
        ),
    }));
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker_store = store.clone();
    let task = tokio::spawn(async move {
        stage
            .work(&worker_store, move |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .await
    });
    entered_rx.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(path.is_dir());
    assert_eq!(store.installations.available_permits(), 0);
    release_tx.send(()).unwrap();
    let _released = store
        .installations
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    assert!(!path.exists());
}

struct ResourceDownloadServer {
    base: reqwest::Url,
    requests: Arc<std::sync::atomic::AtomicUsize>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}

impl ResourceDownloadServer {
    async fn start() -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = reqwest::Url::parse(&format!(
            "http://{}/catalog/release.json",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (count, arrived, gate) = (requests.clone(), entered.clone(), release.clone());
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        let (count, arrived, gate) = (count.clone(), arrived.clone(), gate.clone());
                        connections.spawn(async move {
                            let mut request = Vec::new();
                            let mut buffer = [0u8; 512];
                            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                                let length = socket.read(&mut buffer).await.unwrap();
                                assert!(length > 0 && request.len() + length <= 4096);
                                request.extend_from_slice(&buffer[..length]);
                            }
                            assert!(request.starts_with(b"GET /catalog/tools/helper.bin HTTP/1.1\r\n"));
                            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            arrived.add_permits(1);
                            gate.acquire().await.unwrap().forget();
                            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nshared-tool").await.unwrap();
                            socket.shutdown().await.unwrap();
                        });
                    }
                    Some(result) = connections.join_next(), if !connections.is_empty() => {
                        result.unwrap();
                    }
                }
            }
        });
        Self {
            base,
            requests,
            entered,
            release,
            task,
        }
    }

    async fn close(&mut self) {
        self.task.abort();
        assert!((&mut self.task).await.unwrap_err().is_cancelled());
    }
}

impl Drop for ResourceDownloadServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn market_resource_inputs(
    store: &FilePluginInstallations,
    artifacts: &Arc<dyn ArtifactStore>,
    base: &reqwest::Url,
) -> [fetch::ReleaseInput; 2] {
    let source = upload(artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let mut first = fetch::input(store, source.clone()).await.unwrap();
    let mut second = fetch::input(store, source).await.unwrap();
    first.origin = fetch::Origin::Market(base.clone());
    second.origin = fetch::Origin::Market(base.clone());
    [first, second]
}

async fn fetch_shared_resource(
    store: Arc<FilePluginInstallations>,
    input: fetch::ReleaseInput,
) -> Result<PathBuf> {
    fetch::resource(
        &store,
        &input,
        0,
        "tools/helper.bin",
        11,
        &format!("{:x}", Sha256::digest(b"shared-tool")),
        Arc::new(apk_domain::NoProgress),
    )
    .await
}

#[tokio::test]
async fn concurrent_resource_preparations_download_shared_digest_once() {
    let mut server = ResourceDownloadServer::start().await;
    let (_directory, artifacts, store) =
        setup_with_sources(vec![server.base.join(".").unwrap().to_string()]).await;
    let [first, second] = market_resource_inputs(&store, &artifacts, &server.base).await;
    let first = tokio::spawn(fetch_shared_resource(store.clone(), first));
    tokio::time::timeout(std::time::Duration::from_secs(10), server.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    // 首次真实请求尚未响应，让第二个准备实际进入等待，再放行首个下载。
    let second = fetch_shared_resource(store.clone(), second);
    tokio::pin!(second);
    assert!(futures_util::poll!(&mut second).is_pending());
    server.release.add_permits(1);
    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(first, second)
    })
    .await
    .unwrap();
    let first = first.unwrap().unwrap();
    assert_eq!(second.unwrap(), first);
    assert_eq!(fs::read(first).unwrap(), b"shared-tool");
    assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    server.close().await;
}

#[tokio::test]
async fn cancelling_resource_waiter_preserves_owner_and_cache_reuse() {
    let mut server = ResourceDownloadServer::start().await;
    let (_directory, artifacts, store) =
        setup_with_sources(vec![server.base.join(".").unwrap().to_string()]).await;
    let [first, second] = market_resource_inputs(&store, &artifacts, &server.base).await;
    let first = tokio::spawn(fetch_shared_resource(store.clone(), first));
    tokio::time::timeout(std::time::Duration::from_secs(10), server.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    {
        let waiting = fetch_shared_resource(store.clone(), second);
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        // 丢弃已经轮询到等待点的请求，只撤销等待者，不取消持锁任务。
    }
    assert!(!first.is_finished());
    assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    server.release.add_permits(1);
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(&first).unwrap(), b"shared-tool");
    let idle = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        store.installations.clone().acquire_many_owned(2),
    )
    .await
    .unwrap()
    .unwrap();
    drop(idle);
    let source = upload(&artifacts, release_bytes("1.0.0", b"shared-tool", false)).await;
    let mut next = fetch::input(&store, source).await.unwrap();
    next.origin = fetch::Origin::Market(server.base.clone());
    let reused = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        fetch_shared_resource(store, next),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reused, first);
    assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    server.close().await;
}

#[tokio::test]
async fn resource_waiter_consumes_original_deadline_without_interrupting_owner() {
    let mut server = ResourceDownloadServer::start().await;
    let (_directory, artifacts, store) =
        setup_with_sources(vec![server.base.join(".").unwrap().to_string()]).await;
    let [first, mut second] = market_resource_inputs(&store, &artifacts, &server.base).await;
    let first = tokio::spawn(fetch_shared_resource(store.clone(), first));
    tokio::time::timeout(std::time::Duration::from_secs(10), server.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    second.deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(50);
    assert!(matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            fetch_shared_resource(store, second)
        )
        .await
        .unwrap(),
        Err(Error::Timeout)
    ));
    assert!(!first.is_finished());
    assert_eq!(server.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    server.release.add_permits(1);
    let downloaded = tokio::time::timeout(std::time::Duration::from_secs(10), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(downloaded).unwrap(), b"shared-tool");
    server.close().await;
}

#[tokio::test]
async fn shared_repository_publishes_sdk_descriptor_and_protects_host_and_client_references() {
    let (_directory, artifacts, store) = setup().await;
    let mut versions = Vec::new();
    for version in ["1.0.0", "2.0.0", "3.0.0"] {
        let source = upload(
            &artifacts,
            release_bytes_with_tool_version(version, version, version.as_bytes(), false),
        )
        .await;
        let expected = versions
            .last()
            .map(|record: &InstalledRelease| record.revision.clone());
        versions.push(
            store
                .prepare(source)
                .await
                .unwrap()
                .commit(expected)
                .await
                .unwrap(),
        );
        let idle = store
            .installations
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        drop(idle);
    }
    let repository = repository::open(&store.root).unwrap();
    let tools = versions
        .iter()
        .map(|record| repository::key(&record.tools[0]))
        .collect::<Vec<_>>();
    {
        let writer = repository.write().unwrap();
        assert!(writer.references(&tools[0]).unwrap().is_empty());
        for tool in &tools[1..] {
            assert_eq!(writer.references(tool).unwrap(), ["host-installations"]);
            assert!(matches!(
                writer.remove(tool, &|| Ok(())),
                Err(deviceforge_tool_repository::Error::InUse)
            ));
        }
        writer
            .set_references("third-party-selection", &tools[..1])
            .unwrap();
    }
    let component = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    let resources =
        apk_plugin_sdk::resources::ManagedResources::read(&component.join("resources.json"))
            .unwrap();
    let descriptor = resources.repository.unwrap();
    assert_eq!(descriptor.root, repository.root());
    assert_eq!(descriptor.client_id, "sample_browser");
    assert!(resources.tools["sample_helper"].entries["executable"].is_file());
    let first = repository.path(&tools[0]).unwrap();
    let retained = store.cleanup_resources(false, vec![]).await.unwrap();
    assert!(first.is_dir());
    assert!(
        !retained
            .items
            .iter()
            .any(|item| item.resource.starts_with("tools/"))
    );
    repository
        .write()
        .unwrap()
        .set_references("third-party-selection", &[])
        .unwrap();
    let reader = repository.read().unwrap();
    assert!(
        store
            .cleanup_resources(false, vec![])
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(first.is_dir());
    drop(reader);
    let removed = store.cleanup_resources(false, vec![]).await.unwrap();
    assert!(
        removed
            .items
            .iter()
            .any(|item| item.resource.starts_with("tools/sample_helper/1.0.0/"))
    );
    assert!(!first.exists());
    for tool in &tools[1..] {
        repository.read().unwrap().verify(tool, &|| Ok(())).unwrap();
    }
}
