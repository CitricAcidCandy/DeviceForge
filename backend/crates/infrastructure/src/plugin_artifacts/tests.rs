use super::*;
use crate::artifacts::FileArtifacts;
use apk_domain::artifacts::{ArchivePage, ArtifactStream};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::json;
use std::sync::Mutex;

struct RecordingStore {
    inner: Arc<FileArtifacts>,
    reads: Mutex<Vec<String>>,
    downloads: Mutex<Vec<String>>,
    writes: Mutex<Vec<String>>,
    publication_deadline: Option<Instant>,
    metadata_size: Option<u64>,
    hold_metadata: bool,
    metadata_entered: tokio::sync::Notify,
}
impl RecordingStore {
    fn new(inner: Arc<FileArtifacts>) -> Self {
        Self {
            inner,
            reads: Mutex::new(Vec::new()),
            downloads: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            publication_deadline: None,
            metadata_size: None,
            hold_metadata: false,
            metadata_entered: tokio::sync::Notify::new(),
        }
    }
}
#[async_trait]
impl ArtifactStore for RecordingStore {
    async fn put(&self, filename: String, stream: ArtifactStream) -> Result<Artifact> {
        let ordinal = {
            let mut writes = self.writes.lock().unwrap();
            writes.push(filename.clone());
            writes.len()
        };
        if let Some(deadline) = self.publication_deadline {
            if ordinal == 1 {
                tokio::time::sleep_until(deadline - Duration::from_millis(300)).await;
                // 内存端口模拟首个发布已提交，后续发布保持等待以验证共享预算。
                return Ok(Artifact {
                    id: uuid::Uuid::new_v4().to_string(),
                    filename,
                    media_type: "application/json".into(),
                    size: 2,
                    sha256: "0".repeat(64),
                    created_at: 0,
                });
            }
            return std::future::pending().await;
        }
        self.inner.put(filename, stream).await
    }
    async fn get(&self, id: &str) -> Result<Artifact> {
        self.reads.lock().unwrap().push(id.into());
        if self.hold_metadata {
            self.metadata_entered.notify_one();
            std::future::pending::<()>().await;
        }
        let mut metadata = self.inner.get(id).await?;
        if let Some(size) = self.metadata_size {
            metadata.size = size;
        }
        Ok(metadata)
    }
    async fn delete(&self, id: &str) -> Result<Artifact> {
        self.inner.delete(id).await
    }
    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)> {
        self.downloads.lock().unwrap().push(id.into());
        self.inner.download(id).await
    }
    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage> {
        self.inner.archive_entries(id, offset, limit).await
    }
}
fn selected_access(fields: &[&str], pointers: &[&str]) -> ArtifactAccess {
    ArtifactAccess {
        input_fields: fields.iter().map(|field| (*field).into()).collect(),
        input_pointers: pointers.iter().map(|pointer| (*pointer).into()).collect(),
        outputs: false,
    }
}
async fn stored_png(store: &dyn ArtifactStore) -> Artifact {
    let bytes = include_bytes!("../device_artifacts/fixtures/pixel.png").to_vec();
    store
        .put(
            "source.png".into(),
            Box::pin(stream::once(async move { Ok(bytes.into()) })),
        )
        .await
        .unwrap()
}
async fn setup() -> (tempfile::TempDir, Arc<FileArtifacts>, InvocationFiles) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let files = InvocationFiles::prepare(
        Some(store.as_ref()),
        Some(&ArtifactAccess {
            input_fields: vec![],
            input_pointers: vec![],
            outputs: true,
        }),
        &json!({}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    (directory, store, files)
}
#[test]
fn capabilities_reject_duplicate_and_nested_fields() {
    for fields in [
        vec!["x".into(), "x".into()],
        vec!["input.artifact".into()],
        vec!["../path".into()],
        vec!["".into()],
        vec!["id".into(); 9],
    ] {
        assert!(
            validate(&ArtifactAccess {
                input_fields: fields,
                input_pointers: vec![],
                outputs: false
            })
            .is_err()
        );
    }
}

#[tokio::test]
async fn authorized_dex_input_preserves_identity_bytes_and_releases_private_copy() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let mut bytes = vec![0; 112];
    bytes[..8].copy_from_slice(b"dex\n039\0");
    bytes[32..36].copy_from_slice(&112u32.to_le_bytes());
    bytes[36..40].copy_from_slice(&112u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&0x1234_5678u32.to_le_bytes());
    let upload = bytes.clone();
    let artifact = store
        .put(
            "classes.DEX".into(),
            Box::pin(stream::once(async move { Ok(upload.into()) })),
        )
        .await
        .unwrap();
    let files = InvocationFiles::prepare(
        Some(&store),
        Some(&selected_access(&["artifact_id"], &[])),
        &json!({"artifact_id": artifact.id}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(files.context.inputs.len(), 1);
    let reference = &files.context.inputs[0];
    assert_eq!(reference.artifact_id, artifact.id);
    assert_eq!(reference.field, "artifact_id");
    assert_eq!(reference.filename, "classes.DEX");
    assert_eq!(reference.size, bytes.len() as u64);
    assert_eq!(reference.sha256, artifact.sha256);
    let path = PathBuf::from(&reference.path);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    assert!(files.context.output_directory.is_none());
    drop(files);
    assert!(!path.exists());
    assert_eq!(
        store.get(&artifact.id).await.unwrap().sha256,
        artifact.sha256
    );
}

#[tokio::test]
async fn authorized_binary_and_script_inputs_preserve_identity_and_release_private_copies() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for (filename, bytes) in [
        ("server.BIN", vec![0, 255, 128]),
        ("hook.JS", "const 文本 = '设备';".as_bytes().to_vec()),
    ] {
        let upload = bytes.clone();
        let artifact = store
            .put(
                filename.into(),
                Box::pin(stream::once(async move { Ok(upload.into()) })),
            )
            .await
            .unwrap();
        let files = InvocationFiles::prepare(
            Some(&store),
            Some(&selected_access(&["artifact_id"], &[])),
            &json!({"artifact_id": artifact.id}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let reference = &files.context.inputs[0];
        assert_eq!(reference.filename, filename);
        assert_eq!(reference.artifact_id, artifact.id);
        assert_eq!(reference.sha256, artifact.sha256);
        assert_eq!(reference.size, bytes.len() as u64);
        let path = PathBuf::from(&reference.path);
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
        drop(files);
        assert!(!path.exists());
        assert_eq!(
            store.get(&artifact.id).await.unwrap().sha256,
            artifact.sha256
        );
    }
}

#[tokio::test]
async fn runtime_outputs_validate_every_file_before_publication() {
    let (_directory, inner, files) = setup().await;
    let store = RecordingStore::new(inner);
    let root = files.output.as_ref().unwrap();
    for (filename, bytes) in [
        ("good.log", vec![255, 0, 128]),
        ("bad.js", vec![0xff]),
        ("bad.jsonl", b"{}\ninvalid".to_vec()),
        ("bad.mp4", b"not a video header".to_vec()),
    ] {
        tokio::fs::write(root.join(filename), bytes).await.unwrap();
    }
    for filename in ["bad.js", "bad.jsonl", "bad.mp4"] {
        assert!(matches!(
            files
                .publish(
                    Some(&store),
                    vec![
                        ArtifactOutput {
                            filename: "good.log".into()
                        },
                        ArtifactOutput {
                            filename: filename.into()
                        }
                    ],
                    CancellationToken::new(),
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(store.writes.lock().unwrap().is_empty());
    for (filename, bytes) in [
        ("hook.js", b"const value = 1;".to_vec()),
        ("events.jsonl", Vec::new()),
        ("record.mp4", b"\0\0\0\x18ftypisom".to_vec()),
    ] {
        tokio::fs::write(root.join(filename), bytes).await.unwrap();
    }
    let artifacts = files
        .publish(
            Some(&store),
            ["good.log", "hook.js", "events.jsonl", "record.mp4"]
                .into_iter()
                .map(|filename| ArtifactOutput {
                    filename: filename.into(),
                })
                .collect(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(artifacts.len(), 4);
    assert_eq!(artifacts[0].media_type, "text/plain");
    assert_eq!(artifacts[1].media_type, "text/javascript");
    assert_eq!(artifacts[2].size, 0);
    assert_eq!(artifacts[3].media_type, "video/mp4");
}

#[tokio::test]
async fn multiple_publications_share_deadline_and_do_not_start_later_output() {
    let (_directory, inner, files) = setup().await;
    for filename in ["first.json", "second.json", "third.json"] {
        tokio::fs::write(files.output.as_ref().unwrap().join(filename), b"{}")
            .await
            .unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut store = RecordingStore::new(inner);
    store.publication_deadline = Some(deadline);
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        files.publish_until(
            Some(&store),
            ["first.json", "second.json", "third.json"]
                .into_iter()
                .map(|filename| ArtifactOutput {
                    filename: filename.into(),
                })
                .collect(),
            CancellationToken::new(),
            Some(deadline),
        ),
    )
    .await
    .expect("第二个产物不能重新获得 120 秒发布预算");
    assert!(matches!(result, Err(Error::Timeout)));
    assert_eq!(
        *store.writes.lock().unwrap(),
        vec!["first.json".to_owned(), "second.json".to_owned()]
    );
}

#[tokio::test]
async fn unauthorized_outputs_and_filename_escapes_are_rejected() {
    let (_directory, store, files) = setup().await;
    for filename in [
        "../escape.zip",
        "/escape.zip",
        "dir/result.zip",
        "C:\\escape.zip",
        "file.exe",
    ] {
        assert!(matches!(
            files
                .publish(
                    Some(store.as_ref()),
                    vec![ArtifactOutput {
                        filename: filename.into()
                    }],
                    CancellationToken::new()
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    let no_outputs = InvocationFiles::prepare(None, None, &json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        no_outputs
            .publish(
                Some(store.as_ref()),
                vec![ArtifactOutput {
                    filename: "file.zip".into()
                }],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![
                    ArtifactOutput {
                        filename: "a.zip".into()
                    };
                    9
                ],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn all_output_descriptors_are_validated_before_publication() {
    let (_directory, store, files) = setup().await;
    let root = files.output.as_ref().unwrap();
    tokio::fs::write(
        root.join("good.png"),
        include_bytes!("../device_artifacts/fixtures/pixel.png"),
    )
    .await
    .unwrap();
    tokio::fs::write(root.join("bad.png"), b"not a PNG")
        .await
        .unwrap();
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![
                    ArtifactOutput {
                        filename: "good.png".into()
                    },
                    ArtifactOutput {
                        filename: "bad.png".into()
                    }
                ],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    let mut entries = tokio::fs::read_dir(_directory.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err());
    }
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![
                    ArtifactOutput {
                        filename: "good.png".into()
                    },
                    ArtifactOutput {
                        filename: "GOOD.png".into()
                    }
                ],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn oversized_files_and_non_files_are_rejected() {
    let (_directory, store, files) = setup().await;
    let root = files.output.as_ref().unwrap();
    tokio::fs::File::create(root.join("large.zip"))
        .await
        .unwrap()
        .set_len(LIMIT + 1)
        .await
        .unwrap();
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![ArtifactOutput {
                    filename: "large.zip".into()
                }],
                CancellationToken::new()
            )
            .await,
        Err(Error::TooLarge)
    ));
    tokio::fs::create_dir(root.join("dir.zip")).await.unwrap();
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![ArtifactOutput {
                    filename: "dir.zip".into()
                }],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn input_fields_resolve_only_declared_ids_and_respect_limits() {
    let (_directory, store, _files) = setup().await;
    let access = ArtifactAccess {
        input_fields: vec!["artifact_ids".into()],
        input_pointers: vec![],
        outputs: false,
    };
    let missing = InvocationFiles::prepare(
        Some(store.as_ref()),
        Some(&access),
        &json!({"unrelated":"../secret"}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(missing.context.inputs.is_empty());
    for value in [json!(12), json!([1]), json!(vec!["id"; 9])] {
        assert!(
            InvocationFiles::prepare(
                Some(store.as_ref()),
                Some(&access),
                &json!({"artifact_ids":value}),
                CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
}
#[cfg(unix)]
#[tokio::test]
async fn symlink_outputs_are_rejected() {
    let (_directory, store, files) = setup().await;
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        files.output.as_ref().unwrap().join("result.zip"),
    )
    .unwrap();
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![ArtifactOutput {
                    filename: "result.zip".into()
                }],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn v2_protocol_rejects_invalid_responses_and_preserves_null_envelope() {
    use apk_domain::Executor;
    use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, Contribution, Manifest};
    let directory = tempfile::tempdir().unwrap();
    let executable = directory
        .path()
        .join(if cfg!(windows) { "probe.exe" } else { "probe" });
    let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/plugin_artifacts/fixtures/probe.rs");
    let output = std::process::Command::new("rustc")
        .arg(source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for mode in [
        "empty-error",
        "both",
        "unauthorized",
        "missing",
        "error-with-outputs",
        "mismatch",
        "wrong-version",
        "null",
    ] {
        let plugin = crate::plugins::ProcessPlugin::new(Manifest {
            id: "probe".into(),
            configuration: None,
            recovery: None,
            version: "0.1.0".into(),
            protocol_version: ARTIFACT_PROTOCOL_VERSION,
            executable: executable.to_string_lossy().into_owned(),
            args: vec![mode.into()],
            performance: None,
            devices: None,
            sessions: None,
            artifacts: None,
            operations: vec![Contribution {
                name: "check".into(),
                title: "协议检查".into(),
                input_schema: json!({"type":"object"}),
                execution: None,
            }],
        })
        .unwrap();
        let result = plugin
            .execute("plugin.probe.check", json!({}), CancellationToken::new())
            .await;
        if mode == "null" {
            assert_eq!(result.unwrap(), json!({"result":null,"artifacts":[]}));
        } else {
            assert!(result.is_err(), "应拒绝 {mode}");
        }
    }
}
#[tokio::test]
async fn temporary_output_directory_is_removed_on_drop() {
    let (_directory, _store, files) = setup().await;
    let path = files.directory.path().to_path_buf();
    assert!(path.exists());
    drop(files);
    assert!(!path.exists());
}

#[tokio::test]
async fn nested_and_legacy_inputs_keep_labels_integrity_and_independent_copies() {
    let (_directory, store, _files) = setup().await;
    let source = stored_png(store.as_ref()).await;
    let access = selected_access(&["legacy"], &["/input/artifact_id", "/input/items/0"]);
    let input =
        json!({"legacy": source.id, "input": {"artifact_id":source.id,"items":[[source.id]]}});
    let files = InvocationFiles::prepare(
        Some(store.as_ref()),
        Some(&access),
        &input,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(files.context.inputs.len(), 3);
    let expected = ["legacy", "/input/artifact_id", "/input/items/0"];
    let mut paths = Vec::new();
    for (reference, label) in files.context.inputs.iter().zip(expected) {
        assert_eq!(reference.field, label);
        assert_eq!(reference.artifact_id, source.id);
        assert_eq!(reference.size, source.size);
        assert_eq!(reference.sha256, source.sha256);
        assert_eq!(
            tokio::fs::read(&reference.path).await.unwrap(),
            include_bytes!("../device_artifacts/fixtures/pixel.png")
        );
        paths.push(PathBuf::from(&reference.path));
    }
    assert_ne!(paths[0], paths[1]);
    tokio::fs::write(&paths[0], "副本修改不回写源产物".as_bytes())
        .await
        .unwrap();
    let (_, original) = store.download(&source.id).await.unwrap();
    let original = original
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .unwrap();
    assert_eq!(
        original,
        include_bytes!("../device_artifacts/fixtures/pixel.png")
    );
    let work = files.directory.path().to_owned();
    let input_dirs = paths
        .iter()
        .map(|path| path.parent().unwrap().to_owned())
        .collect::<Vec<_>>();
    drop(files);
    assert!(!work.exists());
    assert!(input_dirs.iter().all(|path| !path.exists()));
    assert!(store.get(&source.id).await.is_ok());
}

#[tokio::test]
async fn all_values_and_mixed_count_are_validated_before_any_store_read() {
    let (_directory, store, _files) = setup().await;
    let store = RecordingStore::new(store);
    let access = selected_access(&["legacy"], &["/input/artifact_id"]);
    for value in [json!(null), json!({}), json!(1), json!(["id", 1])] {
        let input = json!({"legacy":"valid-looking-id","input":{"artifact_id":value}});
        assert!(matches!(
            InvocationFiles::prepare(
                Some(&store),
                Some(&access),
                &input,
                CancellationToken::new()
            )
            .await,
            Err(Error::Invalid(_))
        ));
    }
    let input = json!({"legacy":vec!["id";4],"input":{"artifact_id":vec!["id";5]}});
    assert!(matches!(
        InvocationFiles::prepare(
            Some(&store),
            Some(&access),
            &input,
            CancellationToken::new()
        )
        .await,
        Err(Error::Invalid(_))
    ));
    let bad_intermediate = json!({"legacy":"id","input":12});
    assert!(matches!(
        InvocationFiles::prepare(
            Some(&store),
            Some(&access),
            &bad_intermediate,
            CancellationToken::new()
        )
        .await,
        Err(Error::Invalid(_))
    ));
    assert!(store.reads.lock().unwrap().is_empty());
    assert!(store.downloads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn missing_and_undeclared_nested_ids_never_read_the_store() {
    let (_directory, store, _files) = setup().await;
    let store = RecordingStore::new(store);
    let access = selected_access(&["legacy"], &["/input/artifact_id", "/items/4"]);
    let input = json!({"input":{"unrelated":"unknown-id"},"items":[],"other":"unknown-id"});
    for access in [Some(&access), None] {
        let files =
            InvocationFiles::prepare(Some(&store), access, &input, CancellationToken::new())
                .await
                .unwrap();
        assert!(files.context.inputs.is_empty());
    }
    assert!(store.reads.lock().unwrap().is_empty());
    assert!(store.downloads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mixed_selectors_allow_eight_references_and_count_duplicate_sizes() {
    let (_directory, store, _files) = setup().await;
    let source = stored_png(store.as_ref()).await;
    let mut store = RecordingStore::new(store);
    let access = selected_access(&["legacy"], &["/input/artifact_id"]);
    let input = json!({"legacy":vec![source.id.clone();4],"input":{"artifact_id":vec![source.id.clone();4]}});
    let files = InvocationFiles::prepare(
        Some(&store),
        Some(&access),
        &input,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(files.context.inputs.len(), 8);
    assert_eq!(store.downloads.lock().unwrap().len(), 8);
    let unique_paths = files
        .context
        .inputs
        .iter()
        .map(|input| &input.path)
        .collect::<HashSet<_>>();
    assert_eq!(unique_paths.len(), 8);
    drop(files);
    store.reads.lock().unwrap().clear();
    store.downloads.lock().unwrap().clear();
    // 用元数据夹具检验合计限制，避免测试真实写入几十 MiB。
    store.metadata_size = Some(LIMIT / 2 + 1);
    let input = json!({"legacy":source.id,"input":{"artifact_id":source.id}});
    assert!(matches!(
        InvocationFiles::prepare(
            Some(&store),
            Some(&access),
            &input,
            CancellationToken::new()
        )
        .await,
        Err(Error::TooLarge)
    ));
    assert_eq!(store.reads.lock().unwrap().len(), 2);
    assert_eq!(store.downloads.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cancelled_preparation_does_not_read_or_wait_for_metadata() {
    let (_directory, store, _files) = setup().await;
    let source = stored_png(store.as_ref()).await;
    let mut store = RecordingStore::new(store);
    let access = selected_access(&[], &["/input/artifact_id"]);
    let input = json!({"input":{"artifact_id":source.id}});
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        InvocationFiles::prepare(Some(&store), Some(&access), &input, cancel).await,
        Err(Error::Cancelled)
    ));
    assert!(store.reads.lock().unwrap().is_empty());
    store.hold_metadata = true;
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(
            InvocationFiles::prepare(Some(&store), Some(&access), &input, cancel.clone()),
            async {
                store.metadata_entered.notified().await;
                cancel.cancel();
            }
        )
    })
    .await
    .unwrap();
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(store.downloads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_publication_cleans_nested_input_and_output_directories_on_drop() {
    let (_directory, store, _files) = setup().await;
    let source = stored_png(store.as_ref()).await;
    let mut access = selected_access(&[], &["/input/artifact_id"]);
    access.outputs = true;
    let files = InvocationFiles::prepare(
        Some(store.as_ref()),
        Some(&access),
        &json!({"input":{"artifact_id":source.id}}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    tokio::fs::copy(
        &files.context.inputs[0].path,
        files.output.as_ref().unwrap().join("copy.png"),
    )
    .await
    .unwrap();
    let input_dir = PathBuf::from(&files.context.inputs[0].path)
        .parent()
        .unwrap()
        .to_owned();
    let work_dir = files.directory.path().to_owned();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        files
            .publish(
                Some(store.as_ref()),
                vec![ArtifactOutput {
                    filename: "copy.png".into()
                }],
                cancel
            )
            .await,
        Err(Error::Cancelled)
    ));
    drop(files);
    assert!(!input_dir.exists());
    assert!(!work_dir.exists());
    assert!(store.get(&source.id).await.is_ok());
}
