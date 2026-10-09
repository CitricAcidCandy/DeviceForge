use apk_domain::{Error, Executor, artifacts::ArtifactStore};
use apk_infrastructure::{artifacts::FileArtifacts, plugins::ProcessPlugin};
use apk_plugin_sdk::Manifest;
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn manifest(outputs: bool) -> Manifest {
    let mut manifest: Manifest =
        serde_json::from_str(include_str!("../manifest.example.json")).unwrap();
    manifest.executable = env!("CARGO_BIN_EXE_deviceforge-msgpack-plugin").into();
    manifest.artifacts.as_mut().unwrap().outputs = outputs;
    manifest
}
async fn put(store: &FileArtifacts, name: &str, bytes: Vec<u8>) -> String {
    store
        .put(
            name.into(),
            Box::pin(stream::once(async move { Ok(bytes.into()) })),
        )
        .await
        .unwrap()
        .id
}
async fn download(store: &FileArtifacts, id: &str) -> Vec<u8> {
    let (_, mut stream) = store.download(id).await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk.unwrap());
    }
    bytes
}
async fn call(plugin: &ProcessPlugin, name: &str, input: Value) -> apk_domain::Result<Value> {
    plugin
        .execute(
            &format!("plugin.msgpack.{name}"),
            input,
            CancellationToken::new(),
        )
        .await
}
#[tokio::test]
async fn real_process_converts_both_ways_and_queries_published_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let source =
        json!([{"id":1,"name":"设备甲"},{"id":2,"name":"设备乙"},{"id":u64::MAX,"name":"其他"}]);
    let id = put(&store, "记录.JSON", serde_json::to_vec(&source).unwrap()).await;
    let plugin = ProcessPlugin::with_artifacts(manifest(true), store.clone()).unwrap();
    let encoded = call(&plugin, "encode", json!({"artifact_id":id}))
        .await
        .unwrap();
    assert_eq!(encoded["result"]["source_artifact_id"], id);
    assert_eq!(encoded["artifacts"][0]["media_type"], "application/msgpack");
    let packed_id = encoded["artifacts"][0]["id"].as_str().unwrap();
    assert_ne!(packed_id, id);
    assert_eq!(
        deviceforge_data_codec::decode_json(&download(&store, packed_id).await).unwrap(),
        source
    );
    let decoded = call(&plugin, "decode", json!({"artifact_id":packed_id}))
        .await
        .unwrap();
    let output_id = decoded["artifacts"][0]["id"].as_str().unwrap();
    assert_eq!(decoded["artifacts"][0]["media_type"], "application/json");
    assert_eq!(
        serde_json::from_slice::<Value>(&download(&store, output_id).await).unwrap(),
        source
    );
    let page = call(&plugin, "query", json!({"artifact_id":packed_id,"offset":1,"limit":1,"filter":{"field":"name","operator":"contains","value":"设备"}})).await.unwrap();
    assert_eq!(page["result"]["matched"], 2);
    assert_eq!(page["result"]["records"][0]["id"], 2);
    assert_eq!(page["artifacts"], json!([]));
    let found = call(&plugin, "query", json!({"artifact_id":packed_id,"limit":1,"filter":{"field":"id","operator":"equals","value":u64::MAX}})).await.unwrap();
    assert_eq!(found["result"]["records"][0]["id"], u64::MAX);
}
#[tokio::test]
async fn process_rejects_wrong_type_lossy_data_unknown_fields_and_missing_permission() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let json_id = put(&store, "input.json", b"[]".to_vec()).await;
    let binary_id = put(&store, "binary.msgpack", vec![0xc4, 1, 0]).await;
    let object_id = put(&store, "object.msgpack", vec![0x80]).await;
    let plugin = ProcessPlugin::with_artifacts(manifest(true), store.clone()).unwrap();
    for (name, input) in [
        ("decode", json!({"artifact_id":json_id})),
        ("decode", json!({"artifact_id":binary_id})),
        ("query", json!({"artifact_id":object_id})),
        ("encode", json!({"artifact_id":json_id,"path":"forbidden"})),
        ("query", json!({"artifact_id":object_id,"limit":0})),
    ] {
        assert!(matches!(
            call(&plugin, name, input).await,
            Err(Error::Dependency(_))
        ));
    }
    let unauthorized = ProcessPlugin::with_artifacts(manifest(false), store.clone()).unwrap();
    assert!(matches!(
        call(&unauthorized, "encode", json!({"artifact_id":json_id})).await,
        Err(Error::Dependency(_))
    ));
    // 输入完整性由宿主复制门禁验证，不能仅信任可修改的存储文件。
    tokio::fs::write(directory.path().join(&json_id).join("content"), b"{}")
        .await
        .unwrap();
    assert!(matches!(
        call(&plugin, "encode", json!({"artifact_id":json_id})).await,
        Err(Error::Storage(_))
    ));
}
