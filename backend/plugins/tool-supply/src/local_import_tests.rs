//! 使用真实上传副本和 ZIP 验证离线导入、重复安装与失败时的原版完整性。
use super::*;
use crate::{config::Source, storage::Installed};
use std::{
    io::Cursor,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const ARTIFACT_ID: &str = "12345678-1234-4234-8234-123456789abc";

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
        Self {
            config: Config {
                source: Source::Url("https://127.0.0.1:9/unavailable.json".into()),
                manifest_cache_enabled: true,
                root,
                allow_http: false,
                download_limit: 1024 * 1024,
                extracted_limit: 1024 * 1024,
                file_limit: 100,
                repository: None,
            },
            directory,
            budget: Budget {
                deadline: Instant::now() + Duration::from_secs(10),
                cancel: CancellationToken::new(),
            },
        }
    }

    fn upload(&self, bytes: &[u8], version: &str) -> (Value, Option<ArtifactContext>) {
        let path = self.directory.path().join("upload.zip");
        fs::write(&path, bytes).unwrap();
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let input = json!({"archive_artifact_id":ARTIFACT_ID,"module_id":"demo",
            "manifest":{"manifestVersion":"local-1","modules":[{"name":"demo",
                "version":version,"url":"https://127.0.0.1:9/unavailable.zip",
                "sha256":sha256,"size":bytes.len(),"entryFile":"tool.txt"}]}});
        let artifacts = Some(ArtifactContext {
            inputs: vec![ArtifactInput {
                field: "/archive_artifact_id".into(),
                artifact_id: ARTIFACT_ID.into(),
                filename: "upload.zip".into(),
                size: bytes.len() as u64,
                sha256,
                path: path.to_string_lossy().into_owned(),
            }],
            output_directory: None,
        });
        (input, artifacts)
    }

    async fn install(&self, bytes: &[u8], version: &str) -> Value {
        let (input, artifacts) = self.upload(bytes, version);
        execute(parse(input).unwrap(), artifacts, &self.config, &self.budget)
            .await
            .unwrap()
    }

    fn state(&self) -> Installed {
        storage::installed(&self.config, "demo", &self.budget)
            .unwrap()
            .unwrap()
    }

    fn assert_original(&self) {
        assert_eq!(
            fs::read(self.config.root.join("demo/tool.txt")).unwrap(),
            b"original"
        );
        assert_eq!(self.state().version, "2.0");
        assert!(!self.config.root.join(".transactions/demo").exists());
    }
}

fn zip(name: &str, content: &[u8]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(content).unwrap();
    archive.finish().unwrap().into_inner()
}

#[tokio::test]
async fn offline_import_reopens_persistent_state_and_repeated_import_is_unchanged() {
    let fixture = Fixture::new();
    let bytes = zip("tool.txt", b"original");
    let installed = fixture.install(&bytes, "2.0").await;
    assert_eq!(installed["changed"], true);
    assert_eq!(installed.as_object().unwrap().len(), 4);
    assert_eq!(installed["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(fixture.state().manifest_version, "local-1");
    let repeated = fixture.install(&bytes, "2.0.0").await;
    assert_eq!(repeated["changed"], false);
    assert_eq!(fixture.state().version, "2.0");
    assert!(!fixture.config.root.join(".manifest-cache").exists());
    fixture.assert_original();
}

#[tokio::test]
async fn manifest_and_actual_archive_integrity_failures_preserve_original() {
    let fixture = Fixture::new();
    fixture.install(&zip("tool.txt", b"original"), "2.0").await;
    for failure in 0..4 {
        let (mut input, mut artifacts) = fixture.upload(&zip("tool.txt", b"new"), "3.0");
        let artifact = &mut artifacts.as_mut().unwrap().inputs[0];
        match failure {
            0 => input["manifest"]["modules"][0]["sha256"] = json!("0".repeat(64)),
            1 => input["manifest"]["modules"][0]["size"] = json!(artifact.size + 1),
            2 => {
                artifact.sha256 = "0".repeat(64);
                input["manifest"]["modules"][0]["sha256"] = json!(artifact.sha256);
            }
            _ => {
                artifact.size += 1;
                input["manifest"]["modules"][0]["size"] = json!(artifact.size);
            }
        }
        assert!(
            execute(
                parse(input).unwrap(),
                artifacts,
                &fixture.config,
                &fixture.budget
            )
            .await
            .is_err()
        );
        fixture.assert_original();
    }
}

#[tokio::test]
async fn malformed_archives_and_missing_entries_preserve_original() {
    let fixture = Fixture::new();
    fixture.install(&zip("tool.txt", b"original"), "2.0").await;
    for bytes in [
        b"not a zip".to_vec(),
        zip("other.txt", b"new"),
        zip("../tool.txt", b"new"),
    ] {
        let (input, artifacts) = fixture.upload(&bytes, "3.0");
        assert!(
            execute(
                parse(input).unwrap(),
                artifacts,
                &fixture.config,
                &fixture.budget
            )
            .await
            .is_err()
        );
        fixture.assert_original();
    }
}

#[tokio::test]
async fn downgrade_is_rejected_and_same_version_repairs_content_and_missing_entry() {
    let fixture = Fixture::new();
    fixture.install(&zip("tool.txt", b"original"), "2.0").await;
    let (input, artifacts) = fixture.upload(&zip("tool.txt", b"older"), "1.9");
    assert!(matches!(
        execute(
            parse(input).unwrap(),
            artifacts,
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Invalid("拒绝自动降级已安装模块"))
    ));
    fixture.assert_original();
    let repaired = fixture.install(&zip("tool.txt", b"repaired"), "2.0").await;
    assert_eq!(repaired["changed"], true);
    assert_eq!(
        fs::read(fixture.config.root.join("demo/tool.txt")).unwrap(),
        b"repaired"
    );
    fs::remove_file(fixture.config.root.join("demo/tool.txt")).unwrap();
    assert_eq!(
        fixture.install(&zip("tool.txt", b"repaired"), "2.0").await["changed"],
        true
    );
}

#[tokio::test]
async fn import_rejects_invalid_manifest_and_request_paths_without_touching_original() {
    let fixture = Fixture::new();
    fixture.install(&zip("tool.txt", b"original"), "2.0").await;
    for failure in 0..9 {
        let (mut input, artifacts) = fixture.upload(&zip("tool.txt", b"new"), "3.0");
        match failure {
            0 => input["install_root"] = json!("C:/outside"),
            1 => input["manifest"]["unknown"] = json!(true),
            2 => input["manifest"]["modules"][0]["entryFile"] = json!("../tool.txt"),
            3 => input["manifest"]["modules"][0]["archiveRoot"] = json!("C:/outside"),
            4 => input["manifest"]["modules"][0]["url"] = json!("file:///C:/outside"),
            5 => input["manifest"]["modules"][0]["type"] = json!("runtime"),
            6 => input["module_id"] = json!("missing"),
            7 => input["manifest"]["modules"][0]["version"] = json!("preview"),
            _ => input["archive_artifact_id"] = json!("not-a-uuid"),
        }
        let result = match parse(input) {
            Ok(input) => execute(input, artifacts, &fixture.config, &fixture.budget).await,
            Err(error) => Err(error),
        };
        assert!(result.is_err(), "错误场景 {failure} 应拒绝");
        fixture.assert_original();
    }
}

#[tokio::test]
async fn import_requires_unique_matching_host_authorization_and_a_zip_file() {
    let fixture = Fixture::new();
    for failure in 0..6 {
        let (input, mut artifacts) = fixture.upload(&zip("tool.txt", b"new"), "3.0");
        let context = artifacts.as_mut().unwrap();
        match failure {
            0 => artifacts = None,
            1 => context.inputs.push(context.inputs[0].clone()),
            2 => context.inputs[0].field = "archive_artifact_id".into(),
            3 => context.inputs[0].artifact_id = "other".into(),
            4 => context.inputs[0].filename = "tool.exe".into(),
            _ => context.inputs[0].path = fixture.directory.path().to_string_lossy().into_owned(),
        }
        assert!(
            execute(
                parse(input).unwrap(),
                artifacts,
                &fixture.config,
                &fixture.budget
            )
            .await
            .is_err()
        );
        assert!(!fixture.config.root.join("demo").exists());
        assert!(!fixture.config.root.join(".transactions/demo").exists());
    }
}

#[tokio::test]
async fn import_obeys_existing_module_lock_and_original_cancellation_budget() {
    let fixture = Fixture::new();
    fixture.install(&zip("tool.txt", b"original"), "2.0").await;
    let (input, artifacts) = fixture.upload(&zip("tool.txt", b"new"), "3.0");
    let lock = storage::ModuleLock::acquire(&fixture.config, "demo", &fixture.budget).unwrap();
    assert!(matches!(
        execute(
            parse(input.clone()).unwrap(),
            artifacts.clone(),
            &fixture.config,
            &fixture.budget
        )
        .await,
        Err(Error::Busy)
    ));
    drop(lock);
    let cancelled = fixture.budget.clone();
    cancelled.cancel.cancel();
    assert!(matches!(
        execute(
            parse(input).unwrap(),
            artifacts,
            &fixture.config,
            &cancelled
        )
        .await,
        Err(Error::Cancelled)
    ));
    assert_eq!(
        fs::read(fixture.config.root.join("demo/tool.txt")).unwrap(),
        b"original"
    );
    assert!(!fixture.config.root.join(".transactions/demo").exists());
}

#[test]
fn import_manifest_exposes_controlled_artifact_pointer_and_fifteen_minute_budget() {
    let manifest: apk_plugin_sdk::Manifest =
        serde_json::from_str(include_str!("../manifest.json")).unwrap();
    let access = manifest.artifacts.unwrap();
    assert_eq!(access.input_pointers, ["/archive_artifact_id"]);
    assert!(!access.outputs);
    let operation = manifest
        .operations
        .iter()
        .find(|item| item.name == "import")
        .unwrap();
    assert_eq!(
        operation.execution.as_ref().unwrap().total_timeout_ms,
        900_000
    );
    assert_eq!(operation.input_schema["additionalProperties"], false);
}
