//! 合成来源与跨进程缓存专项，不依赖外部发布源或真实工具。
use super::*;
use crate::{
    budget::Budget,
    config::{Config, MANIFEST_LIMIT, Source},
    error::Error,
    manifest::{LoadError, Manifest},
};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Cursor, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

fn budget() -> Budget {
    Budget {
        deadline: Instant::now() + Duration::from_secs(10),
        cancel: CancellationToken::new(),
    }
}

fn config(directory: &tempfile::TempDir, url: String) -> Config {
    let root = directory.path().join("tools");
    fs::create_dir(&root).unwrap();
    Config {
        source: Source::Url(url),
        manifest_cache_enabled: true,
        root: fs::canonicalize(root).unwrap(),
        allow_http: true,
        download_limit: MANIFEST_LIMIT,
        extracted_limit: MANIFEST_LIMIT,
        file_limit: 100,
    }
}

async fn source_server(manifest: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let replies = Arc::new(Mutex::new(VecDeque::from(vec![
        (200u16, manifest),
        (503u16, b"private source failure".to_vec()),
        (503u16, b"private source failure".to_vec()),
    ])));
    let worker_replies = replies.clone();
    let worker = tokio::spawn(async move {
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(value) => value,
                Err(_) => return,
            };
            let mut request = [0u8; 4096];
            if stream.read(&mut request).await.unwrap_or(0) == 0 {
                continue;
            }
            let Some((status, body)) = worker_replies.lock().unwrap().pop_front() else {
                return;
            };
            let header = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/manifest"), worker)
}

#[tokio::test]
async fn live_then_remote_failure_uses_same_validated_cache_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = serde_json::to_vec(&json!({"manifestVersion":"cache-1","modules":[]})).unwrap();
    let (url, worker) = source_server(manifest).await;
    let config = config(&directory, url);
    let client = crate::network::client().unwrap();
    let live = Manifest::load(&config, &client, &budget()).await.unwrap();
    assert_eq!(live.manifest_source, "live");
    assert!(live.source_error.is_none());
    let cached = Manifest::load(&config, &client, &budget()).await.unwrap();
    assert_eq!(cached.manifest_source, "cache");
    assert_eq!(cached.manifest_sha256, live.manifest_sha256);
    assert!(cached.source_error.unwrap().contains("非成功状态"));
    worker.abort();
    let _ = worker.await;
}

#[tokio::test]
async fn cache_hard_error_is_not_converted_to_source_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = serde_json::to_vec(&json!({"manifestVersion":"cache-1","modules":[]})).unwrap();
    let (url, worker) = source_server(manifest).await;
    let config = config(&directory, url);
    let client = crate::network::client().unwrap();
    Manifest::load(&config, &client, &budget()).await.unwrap();
    let identity = crate::cache::source_digest(match &config.source {
        Source::Url(url) => url,
        _ => unreachable!(),
    })
    .unwrap();
    fs::write(
        config
            .root
            .join(".manifest-cache")
            .join(format!("{identity}.json")),
        b"broken",
    )
    .unwrap();
    assert!(matches!(
        Manifest::load(&config, &client, &budget()).await,
        Err(LoadError::Hard(Error::Invalid(_)))
    ));
    worker.abort();
    let _ = worker.await;
}

#[derive(Clone)]
enum Reply {
    Bytes(u16, Vec<u8>),
    Truncated,
    Oversized,
    Hold {
        entered: Arc<Notify>,
        release: CancellationToken,
    },
}

struct Server {
    base: String,
    routes: Arc<Mutex<HashMap<String, Reply>>>,
    calls: Arc<Mutex<Vec<String>>>,
    stop: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = Arc::new(Mutex::new(HashMap::new()));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = CancellationToken::new();
        let worker_routes = routes.clone();
        let worker_calls = calls.clone();
        let worker_stop = stop.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    biased;
                    _ = worker_stop.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };
                let (mut stream, _) = accepted.unwrap();
                let responding = async {
                    let mut request = Vec::new();
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        let mut buffer = [0u8; 1024];
                        let count = stream.read(&mut buffer).await?;
                        if count == 0 || request.len() + count > 8192 {
                            return Ok::<(), std::io::Error>(());
                        }
                        request.extend_from_slice(&buffer[..count]);
                    }
                    let path = String::from_utf8_lossy(&request)
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_owned();
                    worker_calls.lock().unwrap().push(path.clone());
                    let reply = worker_routes
                        .lock()
                        .unwrap()
                        .get(&path)
                        .cloned()
                        .unwrap_or(Reply::Bytes(503, b"synthetic source failure".to_vec()));
                    match reply {
                        Reply::Bytes(status, bytes) => {
                            stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).as_bytes()).await?;
                            stream.write_all(&bytes).await?;
                        }
                        Reply::Truncated => {
                            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{").await?;
                        }
                        Reply::Oversized => {
                            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MANIFEST_LIMIT + 1).as_bytes()).await?;
                        }
                        Reply::Hold { entered, release } => {
                            entered.notify_one();
                            release.cancelled().await;
                        }
                    }
                    stream.shutdown().await
                };
                tokio::select! {
                    biased;
                    _ = worker_stop.cancelled() => break,
                    _ = tokio::time::timeout(Duration::from_secs(12), responding) => {},
                }
            }
        });
        Self {
            base,
            routes,
            calls,
            stop,
            task: Some(task),
        }
    }

    fn route(&self, path: &str, reply: Reply) {
        self.routes.lock().unwrap().insert(path.into(), reply);
    }

    fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| *call == path)
            .count()
    }

    async fn close(mut self) {
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(3), self.task.take().unwrap())
            .await
            .expect("缓存合成来源退出超过看门狗")
            .unwrap();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn manifest_bytes(version: &str, modules: &[manifest::Module]) -> Vec<u8> {
    serde_json::to_vec(&json!({"manifestVersion":version,"modules":modules})).unwrap()
}

fn archive(bytes: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("entry.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap().into_inner()
}

fn module(id: &str, server: &Server, bytes: &[u8]) -> manifest::Module {
    use sha2::Digest;
    manifest::Module {
        name: id.into(),
        kind: "runtime".into(),
        version: "1.0.0".into(),
        url: format!("{}/{id}.zip", server.base),
        sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
        size: bytes.len() as u64,
        extract_root: None,
        archive_root: None,
        required: true,
        entry_file: Some("entry.txt".into()),
        feature_key: Some("case-assistant".into()),
    }
}

async fn call(
    config: &Config,
    input: input::Input,
    budget: &Budget,
) -> error::Result<serde_json::Value> {
    tokio::time::timeout(
        Duration::from_secs(12),
        operations::execute(input, config, budget),
    )
    .await
    .expect("来源缓存调用超过看门狗")
}

fn identity(config: &Config) -> String {
    match &config.source {
        Source::Url(url) => cache::source_digest(url).unwrap(),
        _ => unreachable!(),
    }
}

fn snapshot_path(config: &Config) -> std::path::PathBuf {
    config
        .root
        .join(".manifest-cache")
        .join(format!("{}.json", identity(config)))
}

const CHILD_CONFIG: &str = "DEVICEFORGE_TOOL_CACHE_TEST_CONFIG";
const CHILD_MODE: &str = "DEVICEFORGE_TOOL_CACHE_TEST_MODE";
const CHILD_REPORT: &str = "DEVICEFORGE_TOOL_CACHE_TEST_REPORT";

struct Child(std::process::Child);

impl Child {
    fn start(config_path: &std::path::Path, mode: &str, report: &std::path::Path) -> Self {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "source_tests::cache_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_CONFIG, config_path)
            .env(CHILD_MODE, mode)
            .env(CHILD_REPORT, report)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        Self(child)
    }

    async fn wait(mut self) {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success(), "缓存专项子进程失败：{status}");
                return;
            }
            assert!(Instant::now() < deadline, "缓存专项子进程超过看门狗");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn deployment_path(directory: &tempfile::TempDir, config: &Config) -> std::path::PathBuf {
    let path = directory.path().join("deployment.json");
    let url = match &config.source {
        Source::Url(url) => url,
        _ => unreachable!(),
    };
    fs::write(
        &path,
        serde_json::to_vec(&json!({"manifest_url":url,
        "install_root":config.root,"allow_http":true}))
        .unwrap(),
    )
    .unwrap();
    path
}

#[test]
fn cache_child() {
    let Some(path) = std::env::var_os(CHILD_CONFIG) else {
        return;
    };
    let config = Config::read_path(std::path::Path::new(&path), &budget()).unwrap();
    let report = std::env::var_os(CHILD_REPORT).unwrap();
    let mode = std::env::var(CHILD_MODE).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        if mode == "catalog" {
            let result = call(&config, input::Input::Catalog, &budget())
                .await
                .unwrap();
            fs::write(report, serde_json::to_vec(&result).unwrap()).unwrap();
        } else if mode == "hold" {
            let held = cache::CacheLock::acquire(&config, &identity(&config), false, &budget())
                .unwrap()
                .unwrap();
            fs::write(&report, b"locked").unwrap();
            let release = std::path::PathBuf::from(&report).with_extension("release");
            let deadline = Instant::now() + Duration::from_secs(10);
            while !release.exists() {
                assert!(Instant::now() < deadline, "缓存跨进程门闩未释放");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            drop(held);
        } else if mode == "write" {
            let report_path = std::path::PathBuf::from(&report);
            let deadline = Instant::now() + Duration::from_secs(10);
            for (index, version) in ["parallel-a", "parallel-b", "parallel-a", "parallel-b"]
                .into_iter()
                .enumerate()
            {
                let held = cache::CacheLock::acquire(&config, &identity(&config), false, &budget())
                    .unwrap()
                    .unwrap();
                fs::write(
                    report_path.with_extension(format!("locked-{index}")),
                    b"locked",
                )
                .unwrap();
                let release = report_path.with_extension(format!("release-{index}"));
                while !release.exists() {
                    assert!(Instant::now() < deadline, "缓存发布门闩未释放");
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                drop(held);
                let manifest: Manifest =
                    serde_json::from_slice(&manifest_bytes(version, &[])).unwrap();
                cache::write(&config, &identity(&config), &manifest, &budget()).unwrap();
                fs::write(
                    report_path.with_extension(format!("published-{index}")),
                    b"published",
                )
                .unwrap();
                let checked = report_path.with_extension(format!("checked-{index}"));
                while !checked.exists() {
                    assert!(Instant::now() < deadline, "缓存发布检查门闩未释放");
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            fs::write(report, b"complete").unwrap();
        } else {
            panic!("未知合成缓存子进程模式");
        }
    });
}

#[tokio::test]
async fn new_process_fallback_reads_same_persistent_identity_and_cross_process_busy_releases() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("verified", &[])),
    );
    let config = config(&directory, format!("{}/manifest", server.base));
    let live = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let deployment = deployment_path(&directory, &config);
    server.route("/manifest", Reply::Bytes(503, Vec::new()));
    let report = directory.path().join("child-report.json");
    Child::start(&deployment, "catalog", &report).wait().await;
    let cached: serde_json::Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
    assert_eq!(cached["manifest_source"], "cache");
    assert_eq!(cached["manifest_sha256"], live["manifest_sha256"]);
    assert_eq!(cached["manifest_version"], live["manifest_version"]);
    let lock_report = directory.path().join("child-lock");
    let child = Child::start(&deployment, "hold", &lock_report);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !lock_report.exists() {
        assert!(Instant::now() < deadline, "缓存子进程未取得锁");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(matches!(
        call(&config, input::Input::Catalog, &budget()).await,
        Err(Error::CacheBusy)
    ));
    fs::write(lock_report.with_extension("release"), b"release").unwrap();
    child.wait().await;
    assert_eq!(
        call(&config, input::Input::Catalog, &budget())
            .await
            .unwrap()["manifest_source"],
        "cache"
    );
    server.close().await;
}

#[tokio::test]
async fn cross_process_short_lock_rejects_readers_and_publishes_complete_envelopes() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(&directory, "http://127.0.0.1:1/manifest".into());
    let initial: Manifest = serde_json::from_slice(&manifest_bytes("parallel-a", &[])).unwrap();
    cache::write(&config, &identity(&config), &initial, &budget()).unwrap();
    let deployment = deployment_path(&directory, &config);
    let report = directory.path().join("child-write");
    let mut child = Child::start(&deployment, "write", &report);
    let deadline = Instant::now() + Duration::from_secs(12);
    for (index, version) in ["parallel-a", "parallel-b", "parallel-a", "parallel-b"]
        .into_iter()
        .enumerate()
    {
        let locked = report.with_extension(format!("locked-{index}"));
        while !locked.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("缓存发布子进程未取得短锁，退出状态：{status}");
            }
            assert!(Instant::now() < deadline, "缓存发布子进程超过看门狗");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(matches!(
            cache::read(&config, &identity(&config), &budget()),
            Err(Error::CacheBusy)
        ));
        fs::write(
            report.with_extension(format!("release-{index}")),
            b"release",
        )
        .unwrap();
        let published = report.with_extension(format!("published-{index}"));
        while !published.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("缓存发布子进程提交失败，退出状态：{status}");
            }
            assert!(Instant::now() < deadline, "缓存发布子进程超过看门狗");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let bytes = fs::read(snapshot_path(&config)).unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let manifest: Manifest = serde_json::from_value(envelope["manifest"].clone()).unwrap();
        assert_eq!(manifest.manifest_version, version);
        assert_eq!(
            envelope["manifest_sha256"],
            cache::digest(&manifest).unwrap()
        );
        assert_eq!(
            cache::read(&config, &identity(&config), &budget())
                .unwrap()
                .unwrap()
                .manifest_version,
            version
        );
        assert!(!snapshot_path(&config).with_extension("pending").exists());
        fs::write(
            report.with_extension(format!("checked-{index}")),
            b"checked",
        )
        .unwrap();
    }
    child.wait().await;
    assert_eq!(fs::read(&report).unwrap(), b"complete");
    assert!(
        cache::read(&config, &identity(&config), &budget())
            .unwrap()
            .is_some()
    );
}

#[test]
fn deployment_cache_defaults_true_and_explicit_false_is_preserved() {
    for enabled in [None, Some(false), Some(true)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut raw = json!({"manifest_url":"https://example.invalid/manifest",
            "install_root":directory.path().join("tools")});
        if let Some(enabled) = enabled {
            raw["manifest_cache_enabled"] = json!(enabled);
        }
        fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        assert_eq!(
            Config::read_path(&path, &budget())
                .unwrap()
                .manifest_cache_enabled,
            enabled.unwrap_or(true)
        );
    }
}

#[tokio::test]
async fn live_refresh_same_version_changed_content_and_source_switch_have_distinct_identity() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let first = manifest_bytes("same", &[]);
    server.route("/manifest", Reply::Bytes(200, first));
    let mut config = config(&directory, format!("{}/manifest", server.base));
    let first = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert_eq!(first["manifest_source"], "live");
    let second: Vec<u8> = serde_json::to_vec(&json!({"manifestVersion":"same",
        "generatedAt":"another-content","modules":[]}))
    .unwrap();
    server.route("/manifest", Reply::Bytes(200, second));
    let refreshed = call(&config, input::Input::Plan(vec![]), &budget())
        .await
        .unwrap();
    assert_ne!(first["manifest_sha256"], refreshed["manifest_sha256"]);
    assert_eq!(first["manifest_version"], refreshed["manifest_version"]);
    server.route("/manifest", Reply::Bytes(503, b"private-body".to_vec()));
    let cached = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert_eq!(cached["manifest_source"], "cache");
    assert_eq!(cached["manifest_sha256"], refreshed["manifest_sha256"]);
    assert!(cached["source_error"].is_string());
    assert!(!cached.to_string().contains("private-body"));
    assert!(!cached.to_string().contains(&server.base));
    config.source = Source::Url(format!("{}/manifest?other=1", server.base));
    let missing = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert!(missing["manifest_version"].is_null());
    assert!(missing["manifest_source"].is_null());
    assert!(missing["manifest_sha256"].is_null());
    assert!(missing["source_error"].is_string());
    server.close().await;
}

#[tokio::test]
async fn allowed_remote_failures_use_one_cache_read_without_retry_or_snapshot_rewrite() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("verified", &[])),
    );
    let config = config(&directory, format!("{}/manifest", server.base));
    let live = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let before = fs::read(snapshot_path(&config)).unwrap();
    for reply in [
        Reply::Bytes(503, b"private-body".to_vec()),
        Reply::Bytes(302, Vec::new()),
        Reply::Truncated,
        Reply::Oversized,
        Reply::Bytes(200, b"not-json".to_vec()),
        Reply::Bytes(200, br#"{"manifestVersion":"","modules":[]}"#.to_vec()),
        Reply::Bytes(
            200,
            br#"{"manifestVersion":"verified","modules":[],"unknown":1}"#.to_vec(),
        ),
    ] {
        let count = server.count("/manifest");
        server.route("/manifest", reply);
        let cached = call(&config, input::Input::Plan(vec![]), &budget())
            .await
            .unwrap();
        assert_eq!(cached["manifest_source"], "cache");
        assert_eq!(cached["manifest_sha256"], live["manifest_sha256"]);
        assert!(cached["source_error"].is_string());
        assert_eq!(server.count("/manifest"), count + 1);
        assert_eq!(fs::read(snapshot_path(&config)).unwrap(), before);
    }
    server.close().await;
    let cached = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert_eq!(cached["manifest_source"], "cache");
    assert_eq!(cached["manifest_sha256"], live["manifest_sha256"]);
}

#[tokio::test]
async fn missing_cache_preserves_queries_but_disabled_cache_and_local_source_never_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let mut config = config(&directory, format!("{}/manifest", server.base));
    for input in [
        input::Input::Catalog,
        input::Input::FeatureStatus("unknown".into()),
    ] {
        let result = call(&config, input, &budget()).await.unwrap();
        assert!(result["manifest_version"].is_null());
        assert!(result["manifest_source"].is_null());
        assert!(result["manifest_sha256"].is_null());
        assert!(result["source_error"].is_string());
    }
    assert!(!config.root.join(".manifest-cache").exists());
    for input in [
        input::Input::Plan(vec![]),
        input::Input::Install("sdk".into()),
        input::Input::FeaturePrepare("case-assistant".into()),
    ] {
        assert!(matches!(
            call(&config, input, &budget()).await,
            Err(Error::Dependency(_))
        ));
    }
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("verified", &[])),
    );
    call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let old = fs::read(snapshot_path(&config)).unwrap();
    server.route("/manifest", Reply::Bytes(503, Vec::new()));
    config.manifest_cache_enabled = false;
    let result = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert!(result["manifest_source"].is_null());
    assert_eq!(fs::read(snapshot_path(&config)).unwrap(), old);
    config.manifest_cache_enabled = true;
    config.source = Source::Local(directory.path().join("missing-local.json"));
    let result = call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    assert!(result["manifest_source"].is_null());
    assert!(result["source_error"].is_string());
    server.close().await;
}

#[tokio::test]
async fn cache_io_corruption_busy_and_pending_are_hard_for_both_query_operations() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("verified", &[])),
    );
    let mut config = config(&directory, format!("{}/manifest", server.base));
    call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let path = snapshot_path(&config);
    let original = fs::read(&path).unwrap();
    for live in [false, true] {
        server.route(
            "/manifest",
            Reply::Bytes(
                if live { 200 } else { 503 },
                if live {
                    manifest_bytes("replacement", &[])
                } else {
                    Vec::new()
                },
            ),
        );
        fs::write(&path, b"broken-cache").unwrap();
        for input in [
            input::Input::Catalog,
            input::Input::FeatureStatus("unknown".into()),
        ] {
            assert!(matches!(
                call(&config, input, &budget()).await,
                Err(Error::Invalid(_))
            ));
        }
        assert_eq!(fs::read(&path).unwrap(), b"broken-cache");
    }
    fs::write(&path, &original).unwrap();
    server.route("/manifest", Reply::Bytes(503, Vec::new()));
    let lock = cache::CacheLock::acquire(&config, &identity(&config), false, &budget())
        .unwrap()
        .unwrap();
    for input in [
        input::Input::Catalog,
        input::Input::FeatureStatus("unknown".into()),
    ] {
        assert!(matches!(
            call(&config, input, &budget()).await,
            Err(Error::CacheBusy)
        ));
    }
    drop(lock);
    let pending = config
        .root
        .join(".manifest-cache")
        .join(format!("{}.pending", identity(&config)));
    fs::create_dir(&pending).unwrap();
    for input in [
        input::Input::Catalog,
        input::Input::FeatureStatus("unknown".into()),
    ] {
        assert!(matches!(
            call(&config, input, &budget()).await,
            Err(Error::Cleanup)
        ));
    }
    fs::remove_dir(&pending).unwrap();
    let cache_directory = config.root.join(".manifest-cache");
    fs::remove_dir_all(&cache_directory).unwrap();
    fs::write(&cache_directory, b"not-directory").unwrap();
    assert!(matches!(
        call(&config, input::Input::Catalog, &budget()).await,
        Err(Error::Invalid(_))
    ));
    fs::remove_file(cache_directory).unwrap();
    config.root = config.root.join("bad\0root");
    let client = network::client().unwrap();
    assert!(matches!(
        Manifest::load(&config, &client, &budget()).await,
        Err(LoadError::Hard(Error::Io(_)))
    ));
    server.close().await;
}

#[tokio::test]
async fn deployment_url_policy_rejection_does_not_fallback_or_touch_cache() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("verified", &[])),
    );
    let mut config = config(&directory, format!("{}/manifest", server.base));
    call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let old = fs::read(snapshot_path(&config)).unwrap();
    config.allow_http = false;
    let count = server.count("/manifest");
    for input in [
        input::Input::Catalog,
        input::Input::FeatureStatus("unknown".into()),
        input::Input::Plan(vec![]),
    ] {
        assert!(matches!(
            call(&config, input, &budget()).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(server.count("/manifest"), count);
    assert_eq!(fs::read(snapshot_path(&config)).unwrap(), old);
    server.close().await;
}

#[tokio::test]
async fn cancellation_is_hard_and_local_source_never_reads_remote_cache() {
    let directory = tempfile::tempdir().unwrap();
    let local = directory.path().join("manifest.json");
    fs::write(&local, b"broken").unwrap();
    let mut config = config(&directory, "http://127.0.0.1:1/unused".into());
    config.source = Source::Local(local);
    let client = crate::network::client().unwrap();
    let cancelled = budget();
    cancelled.cancel.cancel();
    assert!(matches!(
        Manifest::load(&config, &client, &cancelled).await,
        Err(LoadError::Hard(Error::Cancelled))
    ));
    assert!(matches!(
        Manifest::load(&config, &client, &budget()).await,
        Err(LoadError::SourceUnavailable(Error::Invalid(_)))
    ));
}

#[tokio::test]
async fn all_five_outer_results_share_identity_and_prepare_children_stay_four_fields() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let bytes = archive(b"synthetic-runtime");
    let modules = [
        module("first-sdk", &server, &bytes),
        module("second-sdk", &server, &bytes),
    ];
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("snapshot-1", &modules)),
    );
    for id in ["first-sdk", "second-sdk"] {
        server.route(&format!("/{id}.zip"), Reply::Bytes(200, bytes.clone()));
    }
    let config = config(&directory, format!("{}/manifest", server.base));
    let prepared = call(
        &config,
        input::Input::FeaturePrepare("case-assistant".into()),
        &budget(),
    )
    .await
    .unwrap();
    assert_eq!(server.count("/manifest"), 1);
    assert_eq!(prepared["manifest_source"], "live");
    assert!(prepared["source_error"].is_null());
    assert_eq!(prepared["ready"], true);
    for child in prepared["modules"].as_array().unwrap() {
        assert_eq!(child.as_object().unwrap().len(), 4);
        for key in ["module_id", "version", "sha256", "changed"] {
            assert!(child.get(key).is_some());
        }
    }
    for id in ["first-sdk", "second-sdk"] {
        assert_eq!(
            fs::read(config.root.join(id).join("entry.txt")).unwrap(),
            b"synthetic-runtime"
        );
        assert_eq!(server.count(&format!("/{id}.zip")), 1);
    }
    server.route("/manifest", Reply::Bytes(503, Vec::new()));
    for input in [
        input::Input::Catalog,
        input::Input::Plan(vec![]),
        input::Input::Install("first-sdk".into()),
        input::Input::FeatureStatus("case-assistant".into()),
        input::Input::FeaturePrepare("case-assistant".into()),
    ] {
        let count = server.count("/manifest");
        let result = call(&config, input, &budget()).await.unwrap();
        assert_eq!(server.count("/manifest"), count + 1);
        assert_eq!(result["manifest_source"], "cache");
        assert_eq!(result["manifest_version"], "snapshot-1");
        assert_eq!(result["manifest_sha256"], prepared["manifest_sha256"]);
        assert!(result["source_error"].is_string());
        if result.get("changed").is_some() {
            assert_eq!(result["changed"], false);
        }
        if result.get("ready").is_some() {
            assert_eq!(result["ready"], true);
        }
        if result.get("download_bytes").is_some() {
            assert_eq!(result["download_bytes"], 0);
        }
    }
    for id in ["first-sdk", "second-sdk"] {
        assert_eq!(server.count(&format!("/{id}.zip")), 1);
    }
    let count = server.count("/manifest");
    let removed = call(&config, input::Input::Remove("first-sdk".into()), &budget())
        .await
        .unwrap();
    assert_eq!(removed["removed"], true);
    assert!(removed.get("manifest_source").is_none());
    assert_eq!(server.count("/manifest"), count);
    server.close().await;
}

#[tokio::test]
async fn cached_prepare_second_failure_keeps_first_and_never_executes_third_or_retries_source() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let bytes = archive(b"synthetic-runtime");
    let modules = [
        module("first-sdk", &server, &bytes),
        module("second-sdk", &server, &bytes),
        module("third-sdk", &server, &bytes),
    ];
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("snapshot-1", &modules)),
    );
    let config = config(&directory, format!("{}/manifest", server.base));
    call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    server.route("/manifest", Reply::Bytes(503, Vec::new()));
    server.route("/first-sdk.zip", Reply::Bytes(200, bytes));
    server.route("/second-sdk.zip", Reply::Bytes(503, Vec::new()));
    assert!(matches!(
        call(
            &config,
            input::Input::FeaturePrepare("case-assistant".into()),
            &budget()
        )
        .await,
        Err(Error::Dependency(_))
    ));
    assert_eq!(server.count("/manifest"), 2);
    assert_eq!(server.count("/first-sdk.zip"), 1);
    assert_eq!(server.count("/second-sdk.zip"), 1);
    assert_eq!(server.count("/third-sdk.zip"), 0);
    assert_eq!(
        fs::read(config.root.join("first-sdk/entry.txt")).unwrap(),
        b"synthetic-runtime"
    );
    for id in ["second-sdk", "third-sdk"] {
        assert!(!config.root.join(id).exists());
        assert!(!config.root.join(".transactions").join(id).exists());
        let _lock = storage::ModuleLock::acquire(&config, id, &budget()).unwrap();
    }
    server.close().await;
}

#[tokio::test]
async fn old_install_holds_module_before_source_while_network_holds_no_cache_lock() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let bytes = archive(b"runtime");
    let modules = [module("sdk", &server, &bytes)];
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("snapshot-1", &modules)),
    );
    let config = config(&directory, format!("{}/manifest", server.base));
    call(&config, input::Input::Catalog, &budget())
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let release = CancellationToken::new();
    server.route(
        "/manifest",
        Reply::Hold {
            entered: entered.clone(),
            release: release.clone(),
        },
    );
    let worker_config = config.clone();
    let worker_budget = budget();
    let cancellation = worker_budget.cancel.clone();
    let worker = tokio::spawn(async move {
        call(
            &worker_config,
            input::Input::Install("sdk".into()),
            &worker_budget,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    assert!(matches!(
        storage::ModuleLock::acquire(&config, "sdk", &budget()),
        Err(Error::Busy)
    ));
    let cache_lock = cache::CacheLock::acquire(&config, &identity(&config), false, &budget())
        .unwrap()
        .unwrap();
    drop(cache_lock);
    cancellation.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::Cancelled)
    ));
    release.cancel();
    let _module_lock = storage::ModuleLock::acquire(&config, "sdk", &budget()).unwrap();
    assert!(!config.root.join(".transactions/sdk").exists());
    server.close().await;
}

#[tokio::test]
async fn prepare_releases_cache_short_lock_before_module_download_and_cancel_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let server = Server::new().await;
    let bytes = archive(b"runtime");
    let modules = [module("sdk", &server, &bytes)];
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("snapshot-1", &modules)),
    );
    let config = config(&directory, format!("{}/manifest", server.base));
    let entered = Arc::new(Notify::new());
    let release = CancellationToken::new();
    server.route(
        "/sdk.zip",
        Reply::Hold {
            entered: entered.clone(),
            release: release.clone(),
        },
    );
    let worker_config = config.clone();
    let worker_budget = budget();
    let cancellation = worker_budget.cancel.clone();
    let worker = tokio::spawn(async move {
        call(
            &worker_config,
            input::Input::FeaturePrepare("case-assistant".into()),
            &worker_budget,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    assert!(config.root.join(".transactions/sdk").is_dir());
    let cache_lock = cache::CacheLock::acquire(&config, &identity(&config), false, &budget())
        .unwrap()
        .unwrap();
    drop(cache_lock);
    assert!(matches!(
        storage::ModuleLock::acquire(&config, "sdk", &budget()),
        Err(Error::Busy)
    ));
    cancellation.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::Cancelled)
    ));
    release.cancel();
    assert!(!config.root.join(".transactions/sdk").exists());
    let _module_lock = storage::ModuleLock::acquire(&config, "sdk", &budget()).unwrap();
    server.close().await;
}

#[tokio::test]
async fn stalled_source_cancel_or_original_deadline_never_falls_back_to_warmed_cache() {
    for cancel in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let server = Server::new().await;
        server.route(
            "/manifest",
            Reply::Bytes(200, manifest_bytes("verified", &[])),
        );
        let config = config(&directory, format!("{}/manifest", server.base));
        call(&config, input::Input::Catalog, &budget())
            .await
            .unwrap();
        let original = fs::read(snapshot_path(&config)).unwrap();
        let entered = Arc::new(Notify::new());
        let release = CancellationToken::new();
        server.route(
            "/manifest",
            Reply::Hold {
                entered: entered.clone(),
                release: release.clone(),
            },
        );
        let mut worker_budget = budget();
        if !cancel {
            worker_budget.deadline = Instant::now() + Duration::from_millis(500);
        }
        let cancellation = worker_budget.cancel.clone();
        let worker_config = config.clone();
        let worker = tokio::spawn(async move {
            call(&worker_config, input::Input::Catalog, &worker_budget).await
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        if cancel {
            cancellation.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            (cancel, result),
            (true, Err(Error::Cancelled)) | (false, Err(Error::Timeout))
        ));
        assert_eq!(server.count("/manifest"), 2);
        assert_eq!(fs::read(snapshot_path(&config)).unwrap(), original);
        release.cancel();
        server.close().await;
    }
}
