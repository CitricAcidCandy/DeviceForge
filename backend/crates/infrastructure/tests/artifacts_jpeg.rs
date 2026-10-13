use apk_domain::{Error, artifacts::ArtifactStore};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};
use sha2::{Digest, Sha256};

fn jpeg() -> Vec<u8> {
    vec![
        0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0,
        63, 0, 1, 0xff, 0, 2, 0xff, 0xd9,
    ]
}

async fn put(
    store: &FileArtifacts,
    name: &str,
    bytes: Vec<u8>,
) -> apk_domain::Result<apk_domain::artifacts::Artifact> {
    let chunks: Vec<_> = bytes
        .chunks(3)
        .map(|chunk| Ok(chunk.to_vec().into()))
        .collect();
    store.put(name.into(), Box::pin(stream::iter(chunks))).await
}

#[tokio::test]
async fn jpeg_extensions_publish_metadata_and_download_exact_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let bytes = jpeg();
    for name in ["截图.jpeg", "截图.JPG", "截图.JpEg"] {
        let item = put(&store, name, bytes.clone()).await.unwrap();
        assert_eq!(item.filename, name);
        assert_eq!(item.media_type, "image/jpeg");
        assert_eq!(item.size, bytes.len() as u64);
        assert_eq!(item.sha256, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(
            serde_json::to_value(store.get(&item.id).await.unwrap()).unwrap(),
            serde_json::to_value(&item).unwrap()
        );
        let (metadata, mut incoming) = store.download(&item.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            serde_json::to_value(&item).unwrap()
        );
        let mut downloaded = Vec::new();
        while let Some(chunk) = incoming.next().await {
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
async fn invalid_jpeg_is_never_published() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let bytes = jpeg();
    for end in 0..bytes.len() {
        assert!(matches!(
            put(&store, "截断.jpeg", bytes[..end].to_vec()).await,
            Err(Error::Invalid(_))
        ));
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    let mut unsupported = bytes.clone();
    unsupported[3] = 0xc3;
    let mut zero_width = bytes;
    zero_width[10] = 0;
    for bytes in [trailing, unsupported, zero_width, b"PNG".to_vec()] {
        assert!(matches!(
            put(&store, "无效.jpg", bytes).await,
            Err(Error::Invalid(_))
        ));
    }
    let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(entry.file_name().to_string_lossy().starts_with('.'));
    }
}

#[tokio::test]
async fn jpeg_stream_limit_rejects_before_waiting_for_next_chunk() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(directory.path(), 8)
        .await
        .unwrap();
    let incoming = stream::once(async { Ok(jpeg().into()) }).chain(stream::pending());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        store.put("超限.jpeg".into(), Box::pin(incoming)),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(Error::TooLarge)));
}

#[tokio::test]
async fn larger_store_limit_cannot_raise_jpeg_limit() {
    let directory = tempfile::tempdir().unwrap();
    let limit = deviceforge_data_codec::jpeg::MAX_BYTES;
    let store = FileArtifacts::with_limit(directory.path(), limit * 2)
        .await
        .unwrap();
    let incoming = stream::once(async move { Ok(vec![1; limit as usize + 1].into()) })
        .chain(stream::pending());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        store.put("超格式限额.jpeg".into(), Box::pin(incoming)),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(Error::TooLarge)));
}
