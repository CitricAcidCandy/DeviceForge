use apk_domain::{Error, artifacts::ArtifactStore};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};

async fn put(
    store: &FileArtifacts,
    name: &str,
    bytes: Vec<u8>,
) -> apk_domain::Result<apk_domain::artifacts::Artifact> {
    store
        .put(
            name.into(),
            Box::pin(stream::once(async move { Ok(bytes.into()) })),
        )
        .await
}
#[tokio::test]
async fn data_types_download_exact_bytes_and_reject_zip_preview() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for (name, media_type, bytes) in [
        (
            "数据.JSON",
            "application/json",
            br#"{"n":18446744073709551615}"#.to_vec(),
        ),
        ("数据.msgpack", "application/msgpack", vec![0xc4, 1, 0]),
    ] {
        let item = put(&store, name, bytes.clone()).await.unwrap();
        assert_eq!(item.media_type, media_type);
        let (_, mut stream) = store.download(&item.id).await.unwrap();
        let mut downloaded = Vec::new();
        while let Some(chunk) = stream.next().await {
            downloaded.extend(chunk.unwrap());
        }
        assert_eq!(downloaded, bytes);
        assert!(matches!(
            store.archive_entries(&item.id, 0, 1).await,
            Err(Error::Invalid(_))
        ));
    }
}
#[tokio::test]
async fn invalid_data_and_resource_limits_are_never_published() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for (name, bytes) in [
        ("bad.json", br#"{"x":1,"x":2}"#.to_vec()),
        ("bad.json", b"18446744073709551616".to_vec()),
        ("bad.msgpack", vec![0xc1]),
        ("bad.msgpack", vec![0xc0, 0xc0]),
    ] {
        assert!(matches!(
            put(&store, name, bytes).await,
            Err(Error::Invalid(_))
        ));
    }
    for name in ["large.json", "large.msgpack"] {
        // 第一块已超类型限额，第二块永久等待；应立即返回，证明流式门禁提前生效。
        let incoming =
            stream::once(async { Ok(vec![0; deviceforge_data_codec::MAX_BYTES + 1].into()) })
                .chain(stream::pending());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            store.put(name.into(), Box::pin(incoming)),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::TooLarge)));
    }
    let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(entry.file_name().to_string_lossy().starts_with('.'));
    }
}
