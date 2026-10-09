use super::*;
use crate::artifacts::FileArtifacts;
use serde_json::json;
async fn setup() -> (tempfile::TempDir, Arc<FileArtifacts>, InvocationFiles) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let files = InvocationFiles::prepare(
        Some(store.as_ref()),
        Some(&ArtifactAccess {
            input_fields: vec![],
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
                outputs: false
            })
            .is_err()
        );
    }
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
            version: "0.1.0".into(),
            protocol_version: ARTIFACT_PROTOCOL_VERSION,
            executable: executable.to_string_lossy().into_owned(),
            args: vec![mode.into()],
            performance: None,
            devices: None,
            artifacts: None,
            operations: vec![Contribution {
                name: "check".into(),
                title: "协议检查".into(),
                input_schema: json!({"type":"object"}),
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
