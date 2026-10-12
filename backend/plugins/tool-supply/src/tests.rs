//! 真实临时文件、ZIP 与本地 HTTP 验证失败、校验和回滚，不把静态结果当运行证据。
use super::*;
use crate::{
    budget::Budget,
    config::{Config, Source},
    error::Error,
    input::Input,
    storage::Installed,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _directory: tempfile::TempDir,
    config: Config,
    budget: Budget,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("tools");
        fs::create_dir(&root).unwrap();
        let config = Config {
            source: Source::Local(directory.path().join("manifest.json")),
            manifest_cache_enabled: false,
            root,
            allow_http: true,
            download_limit: 1024 * 1024,
            extracted_limit: 1024 * 1024,
            file_limit: 100,
        };
        Self {
            _directory: directory,
            config,
            budget: Budget {
                deadline: Instant::now() + Duration::from_secs(10),
                cancel: CancellationToken::new(),
            },
        }
    }
    fn manifest(&self, url: &str, bytes: &[u8], digest: Option<&str>) {
        let source = match &self.config.source {
            Source::Local(path) => path,
            _ => unreachable!(),
        };
        fs::write(source, serde_json::to_vec(&json!({"manifestVersion":"catalog-1","generatedAt":"2026-10-10",
            "modules":[{"name":"adb","type":"tool","version":"1.2.0","url":url,
                "sha256":digest.map(str::to_owned).unwrap_or_else(||format!("{:x}",Sha256::digest(bytes))),
                "size":bytes.len(),"entryFile":"adb.txt","required":true}]})).unwrap()).unwrap();
    }
    fn old(&self) {
        let target = self.config.root.join("adb");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("adb.txt"), b"old").unwrap();
        storage::write_state(
            &target,
            &Installed {
                module_id: "adb".into(),
                version: "1.0.0".into(),
                sha256: "0".repeat(64),
                manifest_version: "old".into(),
                installed_at_ms: 1,
                kind: "tool".into(),
                entry_file: Some("adb.txt".into()),
                feature_key: None,
                archive_root: None,
            },
            &self.budget,
        )
        .unwrap();
    }
    fn assert_old(&self) {
        assert_eq!(
            fs::read(self.config.root.join("adb/adb.txt")).unwrap(),
            b"old"
        );
        assert_eq!(
            storage::installed(&self.config, "adb", &self.budget)
                .unwrap()
                .unwrap()
                .version,
            "1.0.0"
        );
        assert!(!self.config.root.join(".transactions/adb").exists());
    }
}
fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
async fn server(bytes: Vec<u8>, status: u16) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(
                format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    (format!("http://{address}/tool.zip"), task)
}

#[test]
fn requests_cannot_select_paths_urls_or_programs() {
    for value in [
        json!({"module_id":"../adb"}),
        json!({"module_id":"adb","install_root":"elsewhere"}),
        json!({"module_id":"adb","url":"http://localhost"}),
        json!({"module_id":"adb","executable":"cmd"}),
    ] {
        assert!(input::parse("install", value).is_err());
    }
    assert!(input::parse("catalog", json!({"path":"elsewhere"})).is_err());
    assert!(input::parse("plan", json!({"module_ids":["adb","adb"]})).is_err());
}
#[test]
fn portable_archive_paths_reject_traversal_devices_and_state_overwrite() {
    for path in [
        "../outside",
        "/outside",
        "C:/outside",
        "a\\outside",
        "a/../outside",
        "CON.txt",
        "a/NUL",
        "trailing./file",
        "space /file",
        "a//file",
        storage::STATE_FILE,
    ] {
        assert!(unpack::relative(path, false).is_err(), "必须拒绝：{path}");
    }
    assert!(unpack::relative("bin/adb.exe", false).is_ok());
}
#[test]
fn numeric_version_order_is_stable_and_rejects_unparseable_versions() {
    assert_eq!(
        manifest::compare_version("1.10.0", "1.9.9").unwrap(),
        std::cmp::Ordering::Greater
    );
    assert_eq!(
        manifest::compare_version("1.2", "1.2.0").unwrap(),
        std::cmp::Ordering::Equal
    );
    for version in ["", "1..0", "1.0-preview", "18446744073709551616"] {
        assert!(manifest::version_parts(version).is_err());
    }
}
#[test]
fn failed_commit_renames_real_backup_back_without_changing_version() {
    let fixture = Fixture::new();
    fixture.old();
    let transaction =
        transaction::Transaction::create(&fixture.config, "adb", &fixture.budget).unwrap();
    let target = fixture.config.root.join("adb");
    let backup = transaction.path.join("backup");
    let result = transaction::replace(
        &target,
        &transaction.path.join("missing-payload"),
        &backup,
        &fixture.budget,
    );
    assert!(matches!(result, Err(Error::Io("提交新模块目录失败"))));
    assert!(!backup.exists());
    assert!(
        transaction
            .finish(&fixture.config, result.map(|_| json!({})))
            .is_err()
    );
    fixture.assert_old();
}
#[test]
fn stale_transaction_blocks_install_and_remove_without_deleting_backup() {
    let fixture = Fixture::new();
    fixture.old();
    let transaction =
        transaction::Transaction::create(&fixture.config, "adb", &fixture.budget).unwrap();
    fs::create_dir(transaction.path.join("backup")).unwrap();
    fs::write(transaction.path.join("backup/evidence"), b"keep").unwrap();
    assert!(matches!(
        storage::ModuleLock::acquire(&fixture.config, "adb", &fixture.budget),
        Err(Error::Cleanup)
    ));
    assert!(matches!(
        transaction::remove(&fixture.config, "adb", &fixture.budget),
        Err(Error::Cleanup)
    ));
    assert_eq!(
        fs::read(transaction.path.join("backup/evidence")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn real_download_installs_state_and_explicit_remove_deletes_only_selected_module() {
    let fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new-tool")]);
    let (url, server) = server(bytes.clone(), 200).await;
    fixture.manifest(&url, &bytes, None);
    let result = operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(result["changed"], true);
    assert_eq!(result["version"], "1.2.0");
    assert_eq!(result["manifest_version"], "catalog-1");
    assert_eq!(result["manifest_source"], "live");
    assert_eq!(result["manifest_sha256"].as_str().unwrap().len(), 64);
    assert!(result["source_error"].is_null());
    assert_eq!(
        fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
        b"new-tool"
    );
    let state = storage::installed(&fixture.config, "adb", &fixture.budget)
        .unwrap()
        .unwrap();
    assert_eq!(state.version, "1.2.0");
    assert_eq!(state.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert!(!fixture.config.root.join(".transactions/adb").exists());
    let unchanged = operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(unchanged["changed"], false, "相同版本与摘要不再下载");
    fs::write(fixture.config.root.join("unrelated.txt"), b"keep").unwrap();
    let removed = transaction::remove(&fixture.config, "adb", &fixture.budget).unwrap();
    assert_eq!(removed["removed"], true);
    assert_eq!(removed["version"], "1.2.0");
    assert!(!fixture.config.root.join("adb").exists());
    assert_eq!(
        fs::read(fixture.config.root.join("unrelated.txt")).unwrap(),
        b"keep"
    );
}
#[tokio::test]
async fn sha256_failure_preserves_old_tool_and_cleans_staging() {
    let fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new-tool")]);
    let (url, server) = server(bytes.clone(), 200).await;
    fixture.manifest(&url, &bytes, Some(&"f".repeat(64)));
    assert!(matches!(
        operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Checksum)
    ));
    server.await.unwrap();
    fixture.assert_old();
}
#[tokio::test]
async fn invalid_zip_and_unsafe_member_cannot_replace_old_tool_or_escape_root() {
    for bytes in [
        b"not-a-zip".to_vec(),
        archive(&[("../escaped.txt", b"outside")]),
        archive(&[("adb.txt", b"one"), ("ADB.txt", b"two")]),
    ] {
        let fixture = Fixture::new();
        fixture.old();
        let (url, server) = server(bytes.clone(), 200).await;
        fixture.manifest(&url, &bytes, None);
        assert!(matches!(
            operations::execute(
                Input::Install("adb".into()),
                &fixture.config,
                &fixture.budget
            )
            .await,
            Err(Error::Invalid(_))
        ));
        server.await.unwrap();
        fixture.assert_old();
        assert!(!fixture.config.root.join("escaped.txt").exists());
        assert!(!fixture._directory.path().join("escaped.txt").exists());
    }
}
#[tokio::test]
async fn actual_expansion_and_missing_entry_fail_before_old_directory_is_moved() {
    for missing in [false, true] {
        let mut fixture = Fixture::new();
        fixture.old();
        if !missing {
            fixture.config.extracted_limit = 4;
        }
        let bytes = if missing {
            archive(&[("other.txt", b"unrelated")])
        } else {
            archive(&[("adb.txt", b"larger-than-limit")])
        };
        let (url, server) = server(bytes.clone(), 200).await;
        fixture.manifest(&url, &bytes, None);
        let result = operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget,
        )
        .await;
        if missing {
            assert!(matches!(
                result,
                Err(Error::Invalid("归档缺少清单声明的入口文件"))
            ));
        } else {
            assert!(matches!(result, Err(Error::TooLarge)));
        }
        server.await.unwrap();
        fixture.assert_old();
    }
}
#[tokio::test]
async fn http_failure_does_not_replace_local_version() {
    let fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new")]);
    let (url, server) = server(bytes.clone(), 503).await;
    fixture.manifest(&url, &bytes, None);
    assert!(matches!(
        operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Dependency(_))
    ));
    server.await.unwrap();
    fixture.assert_old();
}
#[tokio::test]
async fn plan_compares_local_version_and_catalog_keeps_local_information_when_source_fails() {
    let fixture = Fixture::new();
    fixture.old();
    fixture.manifest(
        "http://127.0.0.1:1/tool.zip",
        &archive(&[("adb.txt", b"new")]),
        None,
    );
    let plan = operations::execute(
        Input::Plan(vec!["adb".into()]),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(plan["modules"][0]["action"], "update");
    assert_eq!(plan["modules"][0]["installed_version"], "1.0.0");
    assert!(plan["download_bytes"].as_u64().unwrap() > 0);
    let path = match &fixture.config.source {
        Source::Local(path) => path,
        _ => unreachable!(),
    };
    fs::remove_file(path).unwrap();
    let catalog = operations::execute(Input::Catalog, &fixture.config, &fixture.budget)
        .await
        .unwrap();
    assert!(catalog["source_error"].is_string());
    assert!(catalog["manifest_version"].is_null());
    assert!(catalog["manifest_source"].is_null());
    assert!(catalog["manifest_sha256"].is_null());
    assert_eq!(catalog["modules"][0]["action"], "local_only");
    assert_eq!(catalog["modules"][0]["installed_version"], "1.0.0");
}
#[tokio::test]
async fn removal_rejects_real_inflight_install_and_cancel_closes_download_before_cleanup() {
    let fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new")]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    fixture.manifest(&format!("http://{address}/tool.zip"), &bytes, None);
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes(),
            )
            .await
            .unwrap();
        stream.write_all(&bytes[..1]).await.unwrap();
        entered.send(()).unwrap();
        let _ = released.await;
    });
    let config = fixture.config.clone();
    let budget = fixture.budget.clone();
    let install = tokio::spawn(async move {
        operations::execute(Input::Install("adb".into()), &config, &budget).await
    });
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        transaction::remove(&fixture.config, "adb", &fixture.budget),
        Err(Error::Busy)
    ));
    fixture.budget.cancel.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), install)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::Cancelled)
    ));
    release.send(()).unwrap();
    server.await.unwrap();
    let clean_budget = Budget {
        deadline: Instant::now() + Duration::from_secs(2),
        cancel: CancellationToken::new(),
    };
    assert_eq!(
        storage::installed(&fixture.config, "adb", &clean_budget)
            .unwrap()
            .unwrap()
            .version,
        "1.0.0"
    );
    assert_eq!(
        fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
        b"old"
    );
    assert!(!fixture.config.root.join(".transactions/adb").exists());
}

#[tokio::test]
async fn chunked_manifest_is_bounded_without_content_length() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n4\r\n5678\r\n0\r\n\r\n").await.unwrap();
    });
    let result = network::manifest(
        &network::client().unwrap(),
        &format!("http://{address}/manifest"),
        true,
        5,
        &fixture.budget,
    )
    .await;
    assert!(matches!(result, Err(Error::TooLarge)));
    server.await.unwrap();
}
#[tokio::test]
async fn one_original_deadline_stops_stalled_download_and_cleans_uncommitted_files() {
    let mut fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new")]);
    fixture.budget.deadline = Instant::now() + Duration::from_millis(500);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    fixture.manifest(&format!("http://{address}/tool.zip"), &bytes, None);
    let (release, mut released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::select! { accepted=listener.accept() => accepted.unwrap(), _=&mut released => return };
        let mut request = [0u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes(),
            )
            .await
            .unwrap();
        let _ = released.await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget,
        ),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(Error::Timeout)));
    release.send(()).unwrap();
    server.await.unwrap();
    assert_eq!(
        fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
        b"old"
    );
    assert!(!fixture.config.root.join(".transactions/adb").exists());
}

#[tokio::test]
async fn zip_member_table_limit_is_checked_before_library_allocation() {
    let fixture = Fixture::new();
    fixture.old();
    let mut bytes = archive(&[("adb.txt", b"new")]);
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    bytes[end + 8..end + 10].copy_from_slice(&101u16.to_le_bytes());
    bytes[end + 10..end + 12].copy_from_slice(&101u16.to_le_bytes());
    let (url, server) = server(bytes.clone(), 200).await;
    fixture.manifest(&url, &bytes, None);
    assert!(matches!(
        operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::TooLarge)
    ));
    server.await.unwrap();
    fixture.assert_old();
}
#[tokio::test]
async fn runtime_archive_root_and_entry_metadata_install_to_fixed_business_directory() {
    let fixture = Fixture::new();
    let bytes = archive(&[("package/adb.txt", b"runtime")]);
    let (url, server) = server(bytes.clone(), 200).await;
    fixture.manifest(&url, &bytes, None);
    let path = match &fixture.config.source {
        Source::Local(path) => path,
        _ => unreachable!(),
    };
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    manifest["modules"][0]["type"] = json!("runtime");
    manifest["modules"][0]["featureKey"] = json!("adb_runtime");
    manifest["modules"][0]["archiveRoot"] = json!("package");
    manifest["modules"][0]["extractRoot"] = json!("obsolete-target");
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(
        fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
        b"runtime"
    );
    assert!(!fixture.config.root.join("obsolete-target").exists());
    let state = storage::installed(&fixture.config, "adb", &fixture.budget)
        .unwrap()
        .unwrap();
    assert_eq!(state.kind, "runtime");
    assert_eq!(state.feature_key.as_deref(), Some("adb_runtime"));
    assert!(!fixture.config.root.join(".transactions/adb").exists());
}

#[test]
fn catalog_ignores_unrelated_regular_files_with_valid_module_names() {
    let fixture = Fixture::new();
    fixture.old();
    fs::write(fixture.config.root.join("notes"), b"keep").unwrap();
    let installed = storage::all_installed(&fixture.config, &fixture.budget).unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].module_id, "adb");
    assert_eq!(
        fs::read(fixture.config.root.join("notes")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn same_version_digest_and_new_metadata_trigger_repair_not_false_current() {
    let fixture = Fixture::new();
    fixture.old();
    let bytes = archive(&[("adb.txt", b"new")]);
    let (url, server) = server(bytes.clone(), 200).await;
    fixture.manifest(&url, &bytes, None);
    let mut state = storage::installed(&fixture.config, "adb", &fixture.budget)
        .unwrap()
        .unwrap();
    state.version = "1.2.0".into();
    state.sha256 = format!("{:x}", Sha256::digest(&bytes));
    let target = fixture.config.root.join("adb");
    fs::remove_file(target.join(storage::STATE_FILE)).unwrap();
    storage::write_state(&target, &state, &fixture.budget).unwrap();
    let path = match &fixture.config.source {
        Source::Local(path) => path,
        _ => unreachable!(),
    };
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    manifest["modules"][0]["featureKey"] = json!("new_feature");
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let plan = operations::execute(
        Input::Plan(vec!["adb".into()]),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(plan["modules"][0]["action"], "repair");
    let result = operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(result["changed"], true);
    assert_eq!(
        storage::installed(&fixture.config, "adb", &fixture.budget)
            .unwrap()
            .unwrap()
            .feature_key
            .as_deref(),
        Some("new_feature")
    );
    let unchanged = operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(unchanged["changed"], false);
    assert_eq!(unchanged["sha256"], state.sha256);
}

#[tokio::test]
async fn archive_root_change_with_same_zip_repairs_content_and_legacy_state() {
    let fixture = Fixture::new();
    let bytes = archive(&[("A/adb.txt", b"content-A"), ("B/adb.txt", b"content-B")]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/tool.zip", listener.local_addr().unwrap());
    let download = bytes.clone();
    let server = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        download.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(&download).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    fixture.manifest(&url, &bytes, None);
    let path = match &fixture.config.source {
        Source::Local(path) => path,
        _ => unreachable!(),
    };
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    for root in ["A", "B"] {
        manifest["modules"][0]["archiveRoot"] = json!(root);
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let plan = operations::execute(
            Input::Plan(vec!["adb".into()]),
            &fixture.config,
            &fixture.budget,
        )
        .await
        .unwrap();
        assert_eq!(
            plan["modules"][0]["action"],
            if root == "A" { "install" } else { "repair" }
        );
        let result = operations::execute(
            Input::Install("adb".into()),
            &fixture.config,
            &fixture.budget,
        )
        .await
        .unwrap();
        assert_eq!(result["changed"], true);
        assert_eq!(
            fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
            format!("content-{root}").as_bytes()
        );
        assert_eq!(
            storage::installed(&fixture.config, "adb", &fixture.budget)
                .unwrap()
                .unwrap()
                .archive_root
                .as_deref(),
            Some(root)
        );
    }
    let state_path = fixture.config.root.join("adb").join(storage::STATE_FILE);
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("archive_root");
    fs::write(&state_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let state = storage::installed(&fixture.config, "adb", &fixture.budget)
        .unwrap()
        .unwrap();
    assert!(state.archive_root.is_none(), "旧状态仍可读取");
    let plan = operations::execute(
        Input::Plan(vec!["adb".into()]),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(plan["modules"][0]["action"], "repair");
    let result = operations::execute(
        Input::Install("adb".into()),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(result["changed"], true);
    server.await.unwrap();
    assert_eq!(
        fs::read(fixture.config.root.join("adb/adb.txt")).unwrap(),
        b"content-B"
    );
    let current = operations::execute(
        Input::Plan(vec!["adb".into()]),
        &fixture.config,
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(current["modules"][0]["action"], "current");
}
