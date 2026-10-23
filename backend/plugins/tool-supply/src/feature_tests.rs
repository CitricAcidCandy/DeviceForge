use crate::{
    budget::Budget,
    config::{Config, Source},
    error::Error,
    input::{self, Input},
    manifest::Module,
    operations, storage, transaction,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    directory: tempfile::TempDir,
    config: Config,
    budget: Budget,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("tools");
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        Self {
            config: Config {
                source: Source::Local(directory.path().join("manifest.json")),
                manifest_cache_enabled: false,
                root,
                allow_http: true,
                download_limit: 1024 * 1024,
                extracted_limit: 1024 * 1024,
                file_limit: 100,
                repository: None,
            },
            directory,
            budget: fresh_budget(),
        }
    }

    fn manifest(&self, modules: &[Module]) {
        fs::write(
            self.directory.path().join("manifest.json"),
            manifest_bytes("feature-1", modules),
        )
        .unwrap();
    }

    fn managed(&self, module: &Module, version: &str, bytes: &[u8]) {
        let target = self.config.root.join(&module.name);
        fs::create_dir(&target).unwrap();
        fs::write(target.join("entry.txt"), bytes).unwrap();
        storage::write_state(
            &target,
            &storage::Installed {
                module_id: module.name.clone(),
                version: version.into(),
                sha256: module.sha256.clone(),
                manifest_version: "feature-1".into(),
                installed_at_ms: 1,
                kind: module.kind.clone(),
                entry_file: module.entry_file.clone(),
                feature_key: module.feature_key.clone(),
                archive_root: Some(module.archive_root.clone().unwrap_or_default()),
            },
            &self.budget,
        )
        .unwrap();
    }

    async fn call(&self, operation: &str, key: &str) -> crate::error::Result<Value> {
        let input = input::parse(operation, json!({"feature_key":key}))?;
        tokio::time::timeout(
            Duration::from_secs(12),
            operations::execute(input, &self.config, &self.budget),
        )
        .await
        .expect("运行时功能调用超过测试看门狗")
    }

    fn content(&self, id: &str) -> Vec<u8> {
        fs::read(self.config.root.join(id).join("entry.txt")).unwrap()
    }

    fn clean(&self, id: &str) {
        assert!(!self.config.root.join(".transactions").join(id).exists());
        let _lock = storage::ModuleLock::acquire(&self.config, id, &fresh_budget()).unwrap();
    }
}

fn fresh_budget() -> Budget {
    Budget {
        deadline: Instant::now() + Duration::from_secs(10),
        cancel: CancellationToken::new(),
    }
}

fn archive(bytes: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "package/entry.txt",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap().into_inner()
}

fn module(id: &str, key: &str, base: &str, bytes: &[u8]) -> Module {
    Module {
        name: id.into(),
        kind: "runtime".into(),
        version: "1.2.0".into(),
        url: format!("{base}/{id}.zip"),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: bytes.len() as u64,
        extract_root: None,
        archive_root: Some("package".into()),
        required: true,
        entry_file: Some("entry.txt".into()),
        feature_key: Some(key.into()),
    }
}

fn manifest_bytes(version: &str, modules: &[Module]) -> Vec<u8> {
    serde_json::to_vec(&json!({"manifestVersion":version,"modules":modules})).unwrap()
}

#[derive(Clone)]
enum Reply {
    Bytes(u16, Vec<u8>),
    Snapshots(Vec<Vec<u8>>),
    Hold {
        bytes: Vec<u8>,
        entered: Arc<Notify>,
        release: CancellationToken,
    },
}

struct Server {
    base: String,
    routes: Arc<Mutex<HashMap<String, Reply>>>,
    calls: Arc<Mutex<Vec<String>>>,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
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
                let (stream, _) = accepted.unwrap();
                tokio::select! {
                    biased;
                    _ = worker_stop.cancelled() => break,
                    _ = tokio::time::timeout(Duration::from_secs(12),
                        respond(stream, &worker_routes, &worker_calls)) => {},
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
            .expect("合成来源未退出")
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

async fn respond(
    mut stream: TcpStream,
    routes: &Mutex<HashMap<String, Reply>>,
    calls: &Mutex<Vec<String>>,
) -> std::io::Result<()> {
    let mut request = Vec::new();
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let mut buffer = [0u8; 1024];
        let count = stream.read(&mut buffer).await?;
        if count == 0 || request.len() + count > 8192 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..count]);
    }
    let path = String::from_utf8_lossy(&request)
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let index = {
        let mut calls = calls.lock().unwrap();
        let index = calls.iter().filter(|call| **call == path).count();
        calls.push(path.clone());
        index
    };
    let reply = routes
        .lock()
        .unwrap()
        .get(&path)
        .cloned()
        .unwrap_or_else(|| Reply::Bytes(404, Vec::new()));
    let (status, bytes, hold) = match reply {
        Reply::Bytes(status, bytes) => (status, bytes, None),
        Reply::Snapshots(snapshots) => {
            (200, snapshots[index.min(snapshots.len() - 1)].clone(), None)
        }
        Reply::Hold {
            bytes,
            entered,
            release,
        } => (200, bytes, Some((entered, release))),
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .as_bytes(),
        )
        .await?;
    if let Some((entered, release)) = hold {
        stream.write_all(&bytes[..1]).await?;
        entered.notify_one();
        release.cancelled().await;
        stream.write_all(&bytes[1..]).await?;
    } else {
        stream.write_all(&bytes).await?;
    }
    stream.shutdown().await
}

#[test]
fn feature_inputs_use_utf8_bytes_without_module_id_restrictions() {
    for operation in ["runtime_feature.status", "runtime_feature.prepare"] {
        for key in [
            "con".into(),
            "../运行时 SDK".into(),
            " ".into(),
            "a".repeat(128),
            format!("{}aa", "界".repeat(42)),
        ] {
            assert!(input::parse(operation, json!({"feature_key":key})).is_ok());
        }
        for value in [
            json!({}),
            json!({"feature_key":""}),
            json!({"feature_key":"a".repeat(129)}),
            json!({"feature_key":"界".repeat(43)}),
            json!({"feature_key":null}),
            json!({"feature_key":12}),
            json!({"feature_key":"case-assistant","module_id":"sdk"}),
            json!({"feature_key":"case-assistant","url":"http://127.0.0.1"}),
        ] {
            assert!(input::parse(operation, value).is_err());
        }
    }
}

#[test]
fn feature_manifest_declares_strict_inputs_and_original_total_budgets() {
    let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    assert_eq!(manifest["protocol_version"], 4);
    for (name, timeout) in [
        ("runtime_feature.status", 120000),
        ("runtime_feature.prepare", 900000),
    ] {
        let operation = manifest["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert_eq!(operation["execution"]["api_version"], 1);
        assert_eq!(operation["execution"]["total_timeout_ms"], timeout);
        let schema = &operation["input_schema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["feature_key"]));
        assert_eq!(schema["properties"].as_object().unwrap().len(), 1);
        assert_eq!(schema["properties"]["feature_key"]["minLength"], 1);
        assert_eq!(schema["properties"]["feature_key"]["maxLength"], 128);
        assert!(schema["properties"]["feature_key"].get("pattern").is_none());
    }
}

#[tokio::test]
async fn status_matches_all_runtime_modules_in_manifest_order_only() {
    let fixture = Fixture::new();
    let bytes = archive(b"runtime");
    let first = module(
        "zeta-sdk",
        "Case Assistant/中文",
        "http://127.0.0.1:1",
        &bytes,
    );
    let second = module(
        "alpha-sdk",
        "Case Assistant/中文",
        "http://127.0.0.1:1",
        &bytes,
    );
    let mut tool = module(
        "tool-only",
        "Case Assistant/中文",
        "http://127.0.0.1:1",
        &bytes,
    );
    tool.kind = "tool".into();
    let other = module("other-sdk", "other", "http://127.0.0.1:1", &bytes);
    fixture.manifest(&[tool, first, other, second]);
    let result = fixture
        .call("runtime_feature.status", "Case Assistant/中文")
        .await
        .unwrap();
    assert_eq!(result["feature_key"], "Case Assistant/中文");
    assert_eq!(result["manifest_version"], "feature-1");
    assert_eq!(result["manifest_source"], "live");
    assert_eq!(result["manifest_sha256"].as_str().unwrap().len(), 64);
    assert!(result["source_error"].is_null());
    assert_eq!(result["found"], true);
    assert_eq!(result["ready"], false);
    let modules = result["modules"].as_array().unwrap();
    assert_eq!(modules.len(), 2);
    assert_eq!(modules[0]["module_id"], "zeta-sdk");
    assert_eq!(modules[1]["module_id"], "alpha-sdk");
    for row in modules {
        assert_eq!(row["kind"], "runtime");
        assert_eq!(row["action"], "install");
        assert_eq!(row["entry_present"], false);
    }
}

#[tokio::test]
async fn unknown_and_tool_only_features_do_not_use_development_fallbacks() {
    let fixture = Fixture::new();
    let bytes = archive(b"tool");
    let mut tool = module("codex-sdk", "case-assistant", "http://127.0.0.1:1", &bytes);
    tool.kind = "tool".into();
    fixture.manifest(&[tool]);
    for key in ["unknown", "case-assistant"] {
        let result = fixture.call("runtime_feature.status", key).await.unwrap();
        assert_eq!(result["manifest_version"], "feature-1");
        assert!(result["source_error"].is_null());
        assert_eq!(result["found"], false);
        assert_eq!(result["ready"], false);
        assert_eq!(result["modules"], json!([]));
        assert!(matches!(
            fixture.call("runtime_feature.prepare", key).await,
            Err(Error::Invalid("清单不存在指定运行时功能"))
        ));
    }
    assert!(!fixture.config.root.join(".transactions").exists());
}

#[tokio::test]
async fn source_errors_are_sanitized_status_results_but_prepare_fails() {
    for invalid in [false, true] {
        let fixture = Fixture::new();
        if invalid {
            fs::write(
                fixture.directory.path().join("manifest.json"),
                br#"{"manifestVersion":"bad","modules":[{"url":"https://secret.invalid"}]}"#,
            )
            .unwrap();
        }
        let result = fixture
            .call("runtime_feature.status", "case-assistant")
            .await
            .unwrap();
        assert!(result["manifest_version"].is_null());
        assert!(result["manifest_source"].is_null());
        assert!(result["manifest_sha256"].is_null());
        assert!(result["source_error"].is_string());
        assert_eq!(result["found"], false);
        assert_eq!(result["ready"], false);
        assert_eq!(result["modules"], json!([]));
        assert!(!result.to_string().contains("secret.invalid"));
        assert!(
            !result
                .to_string()
                .contains(&fixture.directory.path().display().to_string())
        );
        assert!(
            fixture
                .call("runtime_feature.prepare", "case-assistant")
                .await
                .is_err()
        );
    }
    let mut fixture = Fixture::new();
    let server = Server::new().await;
    server.route(
        "/manifest",
        Reply::Bytes(503, b"synthetic-private-body".to_vec()),
    );
    fixture.config.source = Source::Url(format!("{}/manifest", server.base));
    let result = fixture
        .call("runtime_feature.status", "case-assistant")
        .await
        .unwrap();
    assert!(
        result["source_error"]
            .as_str()
            .unwrap()
            .contains("非成功状态")
    );
    assert!(!result.to_string().contains("synthetic-private-body"));
    assert!(!result.to_string().contains(&server.base));
    assert!(matches!(
        fixture
            .call("runtime_feature.prepare", "case-assistant")
            .await,
        Err(Error::Dependency(_))
    ));
    assert_eq!(server.count("/manifest"), 2);
    server.close().await;
}

#[tokio::test]
async fn status_reads_one_source_snapshot_and_rejects_local_corruption_or_cleanup() {
    let mut fixture = Fixture::new();
    let server = Server::new().await;
    let bytes = archive(b"runtime");
    let first = module("first-sdk", "case-assistant", &server.base, &bytes);
    let second = module("second-sdk", "case-assistant", &server.base, &bytes);
    server.route(
        "/manifest",
        Reply::Snapshots(vec![
            manifest_bytes("snapshot-1", &[first.clone(), second]),
            manifest_bytes("snapshot-2", &[]),
        ]),
    );
    fixture.config.source = Source::Url(format!("{}/manifest", server.base));
    let result = fixture
        .call("runtime_feature.status", "case-assistant")
        .await
        .unwrap();
    assert_eq!(result["manifest_version"], "snapshot-1");
    assert_eq!(result["modules"].as_array().unwrap().len(), 2);
    assert_eq!(server.count("/manifest"), 1);
    assert_eq!(server.calls.lock().unwrap().len(), 1);
    fixture.managed(&first, "1.2.0", b"old");
    fs::write(
        fixture
            .config
            .root
            .join("first-sdk")
            .join(storage::STATE_FILE),
        b"broken",
    )
    .unwrap();
    assert!(matches!(
        fixture
            .call("runtime_feature.status", "case-assistant")
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(server.count("/manifest"), 1, "本地损坏不能伪装成来源降级");
    server.close().await;

    let fixture = Fixture::new();
    let transaction =
        transaction::Transaction::create(&fixture.config, "first-sdk", &fixture.budget).unwrap();
    fs::create_dir(transaction.path.join("backup")).unwrap();
    fs::write(transaction.path.join("backup/evidence"), b"keep").unwrap();
    assert!(matches!(
        fixture
            .call("runtime_feature.status", "case-assistant")
            .await,
        Err(Error::Cleanup)
    ));
    assert_eq!(
        fs::read(transaction.path.join("backup/evidence")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn prepare_uses_one_snapshot_installs_in_order_and_repeat_has_no_downloads() {
    let mut fixture = Fixture::new();
    let server = Server::new().await;
    let first_bytes = archive(b"first-runtime");
    let second_bytes = archive(b"second-runtime");
    let first = module("zeta-sdk", "case-assistant", &server.base, &first_bytes);
    let second = module("alpha-sdk", "case-assistant", &server.base, &second_bytes);
    server.route("/zeta-sdk.zip", Reply::Bytes(200, first_bytes));
    server.route("/alpha-sdk.zip", Reply::Bytes(200, second_bytes));
    server.route(
        "/manifest",
        Reply::Snapshots(vec![
            manifest_bytes("snapshot-1", &[first.clone(), second.clone()]),
            manifest_bytes("snapshot-2", &[]),
        ]),
    );
    fixture.config.source = Source::Url(format!("{}/manifest", server.base));
    let result = fixture
        .call("runtime_feature.prepare", "case-assistant")
        .await
        .unwrap();
    assert_eq!(result["manifest_version"], "snapshot-1");
    assert_eq!(result["feature_key"], "case-assistant");
    assert_eq!(result["ready"], true);
    let modules = result["modules"].as_array().unwrap();
    assert_eq!(modules.len(), 2);
    for (row, module) in modules.iter().zip([&first, &second]) {
        assert_eq!(
            row,
            &json!({"module_id":module.name,"version":"1.2.0",
            "sha256":module.sha256,"changed":true})
        );
        fixture.clean(&module.name);
        assert_eq!(
            storage::installed(&fixture.config, &module.name, &fixture.budget)
                .unwrap()
                .unwrap()
                .manifest_version,
            "snapshot-1"
        );
    }
    assert_eq!(fixture.content("zeta-sdk"), b"first-runtime");
    assert_eq!(fixture.content("alpha-sdk"), b"second-runtime");
    assert_eq!(
        *server.calls.lock().unwrap(),
        vec!["/manifest", "/zeta-sdk.zip", "/alpha-sdk.zip"]
    );
    server.route(
        "/manifest",
        Reply::Bytes(200, manifest_bytes("snapshot-1", &[first, second])),
    );
    let result = fixture
        .call("runtime_feature.prepare", "case-assistant")
        .await
        .unwrap();
    assert!(
        result["modules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["changed"] == false)
    );
    let status = fixture
        .call("runtime_feature.status", "case-assistant")
        .await
        .unwrap();
    assert_eq!(status["ready"], true);
    assert_eq!(server.count("/zeta-sdk.zip"), 1);
    assert_eq!(server.count("/alpha-sdk.zip"), 1);
    assert_eq!(server.count("/manifest"), 3);
    server.close().await;
}

#[tokio::test]
async fn readiness_requires_matching_version_digest_kind_feature_entry_and_archive_root() {
    let bytes = archive(b"runtime");
    for defect in [
        "current",
        "missing-entry",
        "version",
        "digest",
        "kind",
        "feature",
        "entry",
        "root",
        "legacy-root",
    ] {
        let fixture = Fixture::new();
        let module = module("sdk", "case-assistant", "http://127.0.0.1:1", &bytes);
        fixture.manifest(std::slice::from_ref(&module));
        fixture.managed(&module, "1.2.0", b"runtime");
        let target = fixture.config.root.join("sdk");
        let state_path = target.join(storage::STATE_FILE);
        let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        match defect {
            "current" => {}
            "missing-entry" => fs::remove_file(target.join("entry.txt")).unwrap(),
            "version" => state["version"] = json!("9.0.0"),
            "digest" => state["sha256"] = json!("0".repeat(64)),
            "kind" => state["kind"] = json!("tool"),
            "feature" => state["feature_key"] = json!("other"),
            "entry" => {
                fs::write(target.join("other.txt"), b"other").unwrap();
                state["entry_file"] = json!("other.txt");
            }
            "root" => state["archive_root"] = json!("other-root"),
            "legacy-root" => {
                state.as_object_mut().unwrap().remove("archive_root");
            }
            _ => unreachable!(),
        }
        fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
        let result = fixture
            .call("runtime_feature.status", "case-assistant")
            .await
            .unwrap();
        assert_eq!(result["found"], true);
        assert_eq!(result["ready"], defect == "current", "{defect}");
        assert_eq!(
            result["modules"][0]["action"],
            if defect == "current" {
                "current"
            } else if defect == "version" {
                "local_newer"
            } else {
                "repair"
            },
            "{defect}"
        );
        assert_eq!(
            result["modules"][0]["entry_present"],
            defect != "missing-entry"
        );
        if defect == "version" {
            assert!(matches!(
                fixture
                    .call("runtime_feature.prepare", "case-assistant")
                    .await,
                Err(Error::Invalid("拒绝自动降级已安装模块"))
            ));
            assert_eq!(fixture.content("sdk"), b"runtime");
            assert!(!fixture.config.root.join(".transactions").exists());
        }
    }
}

#[tokio::test]
async fn second_failure_keeps_first_commit_restores_second_and_never_executes_third() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let bytes = archive(b"new-runtime");
    let first = module("first-sdk", "case-assistant", &server.base, &bytes);
    let mut second = module("second-sdk", "case-assistant", &server.base, &bytes);
    let third = module("third-sdk", "case-assistant", &server.base, &bytes);
    fixture.managed(&second, "1.0.0", b"old-runtime");
    second.sha256 = "0".repeat(64);
    fixture.manifest(&[first, second, third]);
    server.route("/first-sdk.zip", Reply::Bytes(200, bytes.clone()));
    server.route("/second-sdk.zip", Reply::Bytes(200, bytes));
    assert!(matches!(
        fixture
            .call("runtime_feature.prepare", "case-assistant")
            .await,
        Err(Error::Checksum)
    ));
    assert_eq!(fixture.content("first-sdk"), b"new-runtime");
    assert_eq!(fixture.content("second-sdk"), b"old-runtime");
    assert_eq!(
        storage::installed(&fixture.config, "second-sdk", &fixture.budget)
            .unwrap()
            .unwrap()
            .version,
        "1.0.0"
    );
    assert!(!fixture.config.root.join("third-sdk").exists());
    assert_eq!(
        *server.calls.lock().unwrap(),
        vec!["/first-sdk.zip", "/second-sdk.zip"]
    );
    for id in ["first-sdk", "second-sdk", "third-sdk"] {
        fixture.clean(id);
    }
    let result = fixture
        .call("runtime_feature.status", "case-assistant")
        .await
        .unwrap();
    assert_eq!(result["ready"], false);
    assert_eq!(result["modules"][0]["action"], "current");
    assert_eq!(result["modules"][1]["action"], "update");
    assert_eq!(result["modules"][2]["action"], "install");
    server.close().await;
}

#[tokio::test]
async fn prepare_respects_each_module_lock_and_stops_after_prior_commit() {
    for cleanup in [false, true] {
        let fixture = Fixture::new();
        let server = Server::new().await;
        let bytes = archive(b"runtime");
        let first = module("first-sdk", "case-assistant", &server.base, &bytes);
        let second = module("second-sdk", "case-assistant", &server.base, &bytes);
        let third = module("third-sdk", "case-assistant", &server.base, &bytes);
        fixture.manifest(&[first, second, third]);
        server.route("/first-sdk.zip", Reply::Bytes(200, bytes));
        let lock = if cleanup {
            let transaction =
                transaction::Transaction::create(&fixture.config, "second-sdk", &fixture.budget)
                    .unwrap();
            fs::write(transaction.path.join("evidence"), b"keep").unwrap();
            None
        } else {
            Some(
                storage::ModuleLock::acquire(&fixture.config, "second-sdk", &fixture.budget)
                    .unwrap(),
            )
        };
        let result = fixture
            .call("runtime_feature.prepare", "case-assistant")
            .await;
        if cleanup {
            assert!(matches!(result, Err(Error::Cleanup)));
            assert_eq!(
                fs::read(
                    fixture
                        .config
                        .root
                        .join(".transactions/second-sdk/evidence")
                )
                .unwrap(),
                b"keep"
            );
        } else {
            assert!(matches!(result, Err(Error::Busy)));
        }
        assert_eq!(fixture.content("first-sdk"), b"runtime");
        assert!(!fixture.config.root.join("second-sdk").exists());
        assert!(!fixture.config.root.join("third-sdk").exists());
        assert_eq!(*server.calls.lock().unwrap(), vec!["/first-sdk.zip"]);
        drop(lock);
        fixture.clean("first-sdk");
        server.close().await;
    }
}

#[tokio::test]
async fn cancellation_and_original_deadline_keep_partial_commit_and_clean_current_module() {
    for cancel in [true, false] {
        let mut fixture = Fixture::new();
        let server = Server::new().await;
        let bytes = archive(b"new-runtime");
        let first = module("first-sdk", "case-assistant", &server.base, &bytes);
        let second = module("second-sdk", "case-assistant", &server.base, &bytes);
        let third = module("third-sdk", "case-assistant", &server.base, &bytes);
        fixture.managed(&second, "1.0.0", b"old-runtime");
        fixture.manifest(&[first, second, third]);
        let entered = Arc::new(Notify::new());
        let release = CancellationToken::new();
        server.route("/first-sdk.zip", Reply::Bytes(200, bytes.clone()));
        server.route(
            "/second-sdk.zip",
            Reply::Hold {
                bytes,
                entered: entered.clone(),
                release: release.clone(),
            },
        );
        if !cancel {
            fixture.budget.deadline = Instant::now() + Duration::from_secs(2);
        }
        let config = fixture.config.clone();
        let budget = fixture.budget.clone();
        let original_deadline = budget.deadline;
        let work = tokio::spawn(async move {
            operations::execute(
                Input::FeaturePrepare("case-assistant".into()),
                &config,
                &budget,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        assert_eq!(fixture.content("first-sdk"), b"new-runtime");
        if cancel {
            fixture.budget.cancel.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(3), work)
            .await
            .unwrap()
            .unwrap();
        if cancel {
            assert!(matches!(result, Err(Error::Cancelled)));
        } else {
            assert!(matches!(result, Err(Error::Timeout)));
            assert!(Instant::now() >= original_deadline);
        }
        release.cancel();
        assert_eq!(fixture.content("first-sdk"), b"new-runtime");
        assert_eq!(fixture.content("second-sdk"), b"old-runtime");
        assert!(!fixture.config.root.join("third-sdk").exists());
        assert_eq!(server.count("/first-sdk.zip"), 1);
        assert_eq!(server.count("/second-sdk.zip"), 1);
        assert_eq!(server.count("/third-sdk.zip"), 0);
        for id in ["first-sdk", "second-sdk", "third-sdk"] {
            fixture.clean(id);
        }
        server.close().await;
    }
}

#[tokio::test]
async fn cancelled_or_expired_status_and_prepare_never_become_source_error_successes() {
    for cancel in [true, false] {
        for operation in ["runtime_feature.status", "runtime_feature.prepare"] {
            let mut fixture = Fixture::new();
            if cancel {
                fixture.budget.cancel.cancel();
            } else {
                fixture.budget.deadline = Instant::now();
            }
            let result = fixture.call(operation, "case-assistant").await;
            if cancel {
                assert!(matches!(result, Err(Error::Cancelled)));
            } else {
                assert!(matches!(result, Err(Error::Timeout)));
            }
            assert!(!fixture.config.root.join(".transactions").exists());
        }
    }
}

#[tokio::test]
async fn legacy_install_still_locks_before_manifest_download_and_cancel_releases_lock() {
    let mut fixture = Fixture::new();
    let server = Server::new().await;
    let bytes = archive(b"runtime");
    let module = module("sdk", "case-assistant", &server.base, &bytes);
    fixture.managed(&module, "1.0.0", b"old-runtime");
    let entered = Arc::new(Notify::new());
    let release = CancellationToken::new();
    server.route(
        "/manifest",
        Reply::Hold {
            bytes: manifest_bytes("feature-1", &[module]),
            entered: entered.clone(),
            release: release.clone(),
        },
    );
    fixture.config.source = Source::Url(format!("{}/manifest", server.base));
    let config = fixture.config.clone();
    let budget = fixture.budget.clone();
    let work = tokio::spawn(async move {
        operations::execute(Input::Install("sdk".into()), &config, &budget).await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    assert!(matches!(
        operations::execute(
            Input::Remove("sdk".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Busy)
    ));
    assert!(matches!(
        operations::execute(
            Input::Install("sdk".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Busy)
    ));
    assert_eq!(server.count("/manifest"), 1);
    fixture.budget.cancel.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), work)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::Cancelled)
    ));
    release.cancel();
    assert_eq!(fixture.content("sdk"), b"old-runtime");
    fixture.clean("sdk");
    server.close().await;
}

#[tokio::test]
async fn legacy_operations_keep_missing_entry_repair_and_current_no_download_semantics() {
    let fixture = Fixture::new();
    let bytes = archive(b"runtime");
    let module = module("sdk", "case-assistant", "http://127.0.0.1:1", &bytes);
    fixture.manifest(std::slice::from_ref(&module));
    fixture.managed(&module, "1.2.0", b"runtime");
    let install = operations::execute(
        Input::Install("sdk".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(install["changed"], false);
    fs::remove_file(fixture.config.root.join("sdk/entry.txt")).unwrap();
    for input in [Input::Catalog, Input::Plan(vec!["sdk".into()])] {
        let result = operations::execute(input, &fixture.config, &fixture.budget)
            .await
            .unwrap();
        assert_eq!(result["modules"][0]["entry_present"], false);
        assert_eq!(result["modules"][0]["action"], "repair");
    }
    assert!(matches!(
        operations::execute(
            Input::Install("sdk".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Dependency(_))
    ));
    fixture.clean("sdk");
    let remove = operations::execute(
        Input::Remove("sdk".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(remove["removed"], true);
    assert!(!fixture.config.root.join("sdk").exists());
}

#[tokio::test]
async fn concurrent_status_reports_busy_during_second_prepare_transaction_then_recovers() {
    for prior_second in [false, true] {
        let fixture = Fixture::new();
        let server = Server::new().await;
        let bytes = archive(b"new-runtime");
        let first = module("first-sdk", "case-assistant", &server.base, &bytes);
        let second = module("second-sdk", "case-assistant", &server.base, &bytes);
        if prior_second {
            fixture.managed(&second, "1.0.0", b"old-runtime");
        }
        fixture.manifest(&[first, second]);
        let entered = Arc::new(Notify::new());
        let release = CancellationToken::new();
        server.route("/first-sdk.zip", Reply::Bytes(200, bytes.clone()));
        server.route(
            "/second-sdk.zip",
            Reply::Hold {
                bytes,
                entered: entered.clone(),
                release: release.clone(),
            },
        );
        let config = fixture.config.clone();
        let budget = fixture.budget.clone();
        let work = tokio::spawn(async move {
            operations::execute(
                Input::FeaturePrepare("case-assistant".into()),
                &config,
                &budget,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        assert_eq!(fixture.content("first-sdk"), b"new-runtime");
        assert!(
            fixture
                .config
                .root
                .join(".transactions/second-sdk")
                .is_dir()
        );
        assert_eq!(
            fixture.config.root.join("second-sdk").exists(),
            prior_second
        );
        for key in ["case-assistant", "unknown"] {
            assert!(matches!(
                fixture.call("runtime_feature.status", key).await,
                Err(Error::Busy)
            ));
        }
        fs::write(fixture.directory.path().join("manifest.json"), b"invalid").unwrap();
        assert!(matches!(
            fixture
                .call("runtime_feature.status", "case-assistant")
                .await,
            Err(Error::Busy)
        ));
        release.cancel();
        let prepared = tokio::time::timeout(Duration::from_secs(3), work)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(prepared["modules"].as_array().unwrap().len(), 2);
        assert_eq!(prepared["ready"], true);
        assert_eq!(fixture.content("second-sdk"), b"new-runtime");
        assert_eq!(server.count("/first-sdk.zip"), 1);
        assert_eq!(server.count("/second-sdk.zip"), 1);
        for id in ["first-sdk", "second-sdk"] {
            fixture.clean(id);
        }
        let modules = [
            module(
                "first-sdk",
                "case-assistant",
                &server.base,
                &archive(b"new-runtime"),
            ),
            module(
                "second-sdk",
                "case-assistant",
                &server.base,
                &archive(b"new-runtime"),
            ),
        ];
        fixture.manifest(&modules);
        let status = fixture
            .call("runtime_feature.status", "case-assistant")
            .await
            .unwrap();
        assert_eq!(status["ready"], true);
        server.close().await;
    }
}

#[tokio::test]
async fn status_preserves_unrelated_stable_corruption_for_unknown_or_failed_source() {
    for invalid_source in [false, true] {
        for residual in [false, true] {
            let fixture = Fixture::new();
            fixture.manifest(&[]);
            if invalid_source {
                fs::write(fixture.directory.path().join("manifest.json"), b"invalid").unwrap();
            }
            if residual {
                let transaction = transaction::Transaction::create(
                    &fixture.config,
                    "unrelated-sdk",
                    &fixture.budget,
                )
                .unwrap();
                fs::write(transaction.path.join("evidence"), b"preserve").unwrap();
            } else {
                fs::create_dir(fixture.config.root.join("unrelated-sdk")).unwrap();
                fs::write(
                    fixture
                        .config
                        .root
                        .join("unrelated-sdk")
                        .join(storage::STATE_FILE),
                    b"invalid",
                )
                .unwrap();
            }
            let result = fixture.call("runtime_feature.status", "unknown").await;
            if residual {
                assert!(matches!(result, Err(Error::Cleanup)));
                assert_eq!(
                    fs::read(
                        fixture
                            .config
                            .root
                            .join(".transactions/unrelated-sdk/evidence")
                    )
                    .unwrap(),
                    b"preserve"
                );
            } else {
                assert!(matches!(result, Err(Error::Invalid(_))));
            }
            let _lock = storage::ModuleLock::acquire(&fixture.config, "other-sdk", &fixture.budget)
                .unwrap();
        }
    }
}

#[tokio::test]
async fn legacy_and_feature_operations_reject_invalid_entry_metadata_without_downloads() {
    let fixture = Fixture::new();
    let server = Server::new().await;
    let bytes = archive(b"runtime");
    let mut module = module("sdk", "case-assistant", &server.base, &bytes);
    module.entry_file = Some("../entry.txt".into());
    fixture.manifest(std::slice::from_ref(&module));
    fixture.managed(&module, "1.2.0", b"keep-runtime");
    for input in [
        Input::Catalog,
        Input::Plan(vec!["sdk".into()]),
        Input::Install("sdk".into()),
        Input::FeatureStatus("case-assistant".into()),
        Input::FeaturePrepare("case-assistant".into()),
    ] {
        assert!(matches!(
            operations::execute(input, &fixture.config, &fixture.budget).await,
            Err(Error::Invalid(_))
        ));
        assert_eq!(fixture.content("sdk"), b"keep-runtime");
        fixture.clean("sdk");
    }
    assert!(server.calls.lock().unwrap().is_empty());
    let removed = operations::execute(
        Input::Remove("sdk".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await;
    assert!(matches!(removed, Err(Error::Invalid(_))));
    fs::remove_dir_all(fixture.config.root.join("sdk")).unwrap();
    fixture.clean("sdk");
    server.close().await;
}
