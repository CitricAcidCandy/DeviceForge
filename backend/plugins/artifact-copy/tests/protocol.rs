use apk_domain::{Error, Executor, artifacts::ArtifactStore};
use apk_infrastructure::{artifacts::FileArtifacts, plugins::ProcessPlugin};
use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, ArtifactAccess, Contribution, Manifest};
use futures_util::{StreamExt, TryStreamExt};
use serde_json::json;
use std::sync::Arc;
use tokio_util::{io::ReaderStream, sync::CancellationToken};
fn manifest(outputs: bool) -> Manifest {
    Manifest {
        services: None,
        configuration: None,
        recovery: None,
        id: "copy".into(),
        version: "0.1.0".into(),
        protocol_version: ARTIFACT_PROTOCOL_VERSION,
        executable: env!("CARGO_BIN_EXE_deviceforge-artifact-copy-plugin").into(),
        args: vec![],
        performance: None,
        devices: None,
        sessions: None,
        artifacts: Some(ArtifactAccess {
            input_fields: vec!["artifact_id".into()],
            input_pointers: vec![],
            outputs,
        }),
        operations: vec![Contribution {
            name: "copy".into(),
            title: "复制产物".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }],
    }
}
async fn store() -> (tempfile::TempDir, Arc<FileArtifacts>, String) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let path = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(
        path.path(),
        include_bytes!("../../../crates/infrastructure/src/device_artifacts/fixtures/pixel.png"),
    )
    .await
    .unwrap();
    let reader = tokio::fs::File::open(path.path()).await.unwrap();
    let artifact = store
        .put(
            "像素.png".into(),
            Box::pin(ReaderStream::new(reader).map_err(|e| Error::Storage(e.to_string()))),
        )
        .await
        .unwrap();
    (directory, store, artifact.id)
}
#[tokio::test]
async fn real_plugin_copies_verified_artifact_and_host_publishes_result() {
    let (_directory, store, id) = store().await;
    let plugin = ProcessPlugin::with_artifacts(manifest(true), store.clone()).unwrap();
    let result = plugin
        .execute(
            "plugin.copy.copy",
            json!({"artifact_id":id}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["result"]["source_artifact_id"], id);
    let output_id = result["artifacts"][0]["id"].as_str().unwrap();
    assert_ne!(id, output_id);
    let source = store.get(&id).await.unwrap();
    let output = store.get(output_id).await.unwrap();
    assert_eq!(source.sha256, output.sha256);
    assert_eq!(output.filename, "像素.png");
    let (_, mut stream) = store.download(output_id).await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(
        bytes,
        include_bytes!("../../../crates/infrastructure/src/device_artifacts/fixtures/pixel.png")
    );
}
#[tokio::test]
async fn missing_output_permission_and_corrupted_inputs_fail() {
    let (directory, store, id) = store().await;
    let plugin = ProcessPlugin::with_artifacts(manifest(false), store.clone()).unwrap();
    assert!(matches!(
        plugin
            .execute(
                "plugin.copy.copy",
                json!({"artifact_id":id}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Dependency(_))
    ));
    let mut bytes = tokio::fs::read(directory.path().join(&id).join("content"))
        .await
        .unwrap();
    bytes[0] ^= 1;
    tokio::fs::write(directory.path().join(&id).join("content"), bytes)
        .await
        .unwrap();
    let plugin = ProcessPlugin::with_artifacts(manifest(true), store).unwrap();
    assert!(matches!(
        plugin
            .execute(
                "plugin.copy.copy",
                json!({"artifact_id":id}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Storage(_))
    ));
}
