//! 真实 ZIP 与公开仓库共同验证托管选择、离线复用及引用删除保护。
use crate::{
    budget::Budget,
    config::{Config, Source},
    error::Error,
    local_import, managed, manifest, network, operations, storage,
};
use apk_plugin_sdk::{ArtifactContext, ArtifactInput, resources::ManagedRepository};
use deviceforge_tool_repository::{Repository, ToolKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    temporary: tempfile::TempDir,
    repository: Repository,
    config: Config,
    budget: Budget,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let repository = Repository::open(&temporary.path().join("tools")).unwrap();
        let root = repository.client_directory("tool-supply").unwrap();
        Self {
            config: Config {
                source: Source::Url("https://127.0.0.1:9/unavailable.json".into()),
                manifest_cache_enabled: true,
                root,
                allow_http: false,
                download_limit: 1024 * 1024,
                extracted_limit: 1024 * 1024,
                file_limit: 100,
                repository: Some(ManagedRepository {
                    format_version: 1,
                    root: repository.root().to_owned(),
                    client_id: "tool-supply".into(),
                }),
            },
            repository,
            temporary,
            budget: Budget {
                deadline: Instant::now() + Duration::from_secs(10),
                cancel: CancellationToken::new(),
            },
        }
    }
    fn archive(&self) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            ("bundle/tool.txt", b"tool".as_slice()),
            ("license.txt", b"license".as_slice()),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn module(&self, bytes: &[u8]) -> manifest::Module {
        serde_json::from_value(json!({"name":"demo","version":"1.0.0",
            "url":"https://127.0.0.1:9/unavailable.zip","sha256":format!("{:x}",Sha256::digest(bytes)),
            "size":bytes.len(),"archiveRoot":"bundle","entryFile":"tool.txt"})).unwrap()
    }
    fn key(&self, bytes: &[u8]) -> ToolKey {
        ToolKey {
            id: "demo".into(),
            version: "1.0.0".into(),
            platform: Repository::platform(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
    async fn import(&self) -> crate::error::Result<Value> {
        let bytes = self.archive();
        let module = self.module(&bytes);
        let path = self.temporary.path().join("upload.zip");
        fs::write(&path, &bytes).unwrap();
        let id = "12345678-1234-4234-8234-123456789abc";
        let input = local_import::parse(json!({"archive_artifact_id":id,"module_id":"demo",
            "manifest":{"manifestVersion":"shared-1","modules":[module]}}))
        .unwrap();
        local_import::execute(
            input,
            Some(ArtifactContext {
                inputs: vec![ArtifactInput {
                    field: "/archive_artifact_id".into(),
                    artifact_id: id.into(),
                    filename: "upload.zip".into(),
                    size: bytes.len() as u64,
                    sha256: module.sha256,
                    path: path.to_string_lossy().into_owned(),
                }],
                output_directory: None,
            }),
            &self.config,
            &self.budget,
        )
        .await
    }
}

#[tokio::test]
async fn import_keeps_full_archive_and_separates_selection_from_immutable_content() {
    let fixture = Fixture::new();
    assert_eq!(fixture.import().await.unwrap()["changed"], true);
    let key = fixture.key(&fixture.archive());
    let content = fixture.repository.path(&key).unwrap();
    assert_eq!(fs::read(content.join("bundle/tool.txt")).unwrap(), b"tool");
    assert_eq!(fs::read(content.join("license.txt")).unwrap(), b"license");
    assert!(!content.join(storage::STATE_FILE).exists());
    assert!(
        fixture
            .config
            .root
            .join("demo")
            .join(storage::STATE_FILE)
            .is_file()
    );
    let state = storage::installed(&fixture.config, "demo", &fixture.budget)
        .unwrap()
        .unwrap();
    assert_eq!(state.archive_root.as_deref(), Some("bundle"));
    assert!(operations::entry_present(&fixture.config, &state, &fixture.budget).unwrap());
    assert!(!fixture.config.root.join("demo/bundle/tool.txt").exists());
    assert_eq!(fixture.import().await.unwrap()["changed"], false);
    assert_eq!(
        fixture
            .repository
            .write()
            .unwrap()
            .references(&key)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn shared_content_is_reused_without_contacting_unavailable_download_source() {
    let fixture = Fixture::new();
    let bytes = fixture.archive();
    let key = fixture.key(&bytes);
    let stage = fixture.repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir_all(payload.join("bundle")).unwrap();
    fs::write(payload.join("bundle/tool.txt"), b"tool").unwrap();
    fs::write(payload.join("license.txt"), b"license").unwrap();
    fixture
        .repository
        .write()
        .unwrap()
        .publish(&key, &payload, &|| Ok(()))
        .unwrap();
    let result = operations::install_snapshot(
        &fixture.config,
        &fixture.module(&bytes),
        "shared-1",
        &network::client().unwrap(),
        &fixture.budget,
    )
    .await
    .unwrap();
    assert_eq!(result["changed"], true);
    assert_eq!(result.as_object().unwrap().len(), 4);
    assert!(
        storage::installed(&fixture.config, "demo", &fixture.budget)
            .unwrap()
            .is_some()
    );
    assert!(
        fixture
            .repository
            .path(&key)
            .unwrap()
            .join("bundle/tool.txt")
            .exists()
    );
}

#[tokio::test]
async fn host_active_and_previous_references_block_supplier_removal_and_keep_selection() {
    let fixture = Fixture::new();
    fixture.import().await.unwrap();
    let key = fixture.key(&fixture.archive());
    for owner in ["host-active", "host-previous"] {
        fixture
            .repository
            .write()
            .unwrap()
            .set_references(owner, std::slice::from_ref(&key))
            .unwrap();
    }
    for owner in ["host-active", "host-previous"] {
        assert!(matches!(
            managed::remove(&fixture.config, "demo", &fixture.budget),
            Err(Error::Invalid(_))
        ));
        assert!(
            storage::installed(&fixture.config, "demo", &fixture.budget)
                .unwrap()
                .is_some()
        );
        assert!(fixture.repository.path(&key).unwrap().is_dir());
        fixture
            .repository
            .write()
            .unwrap()
            .set_references(owner, &[])
            .unwrap();
    }
    assert_eq!(
        managed::remove(&fixture.config, "demo", &fixture.budget).unwrap()["removed"],
        true
    );
    assert!(!fixture.repository.path(&key).unwrap().exists());
    assert!(
        storage::installed(&fixture.config, "demo", &fixture.budget)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn invocation_lease_blocks_mutation_and_cancelled_verification_keeps_content() {
    let fixture = Fixture::new();
    fixture.import().await.unwrap();
    let key = fixture.key(&fixture.archive());
    let lease = fixture.repository.read().unwrap();
    assert!(matches!(
        managed::remove(&fixture.config, "demo", &fixture.budget),
        Err(Error::Busy)
    ));
    drop(lease);
    let state = storage::installed(&fixture.config, "demo", &fixture.budget)
        .unwrap()
        .unwrap();
    fixture.budget.cancel.cancel();
    assert!(matches!(
        managed::content_path(&fixture.config, &state, &fixture.budget),
        Err(Error::Cancelled)
    ));
    assert!(fixture.repository.path(&key).unwrap().is_dir());
}
