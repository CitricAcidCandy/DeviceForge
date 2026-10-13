use apk_domain::{
    Error,
    artifacts::{ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};

fn candidate(version: &[u8; 3], size: usize) -> Vec<u8> {
    let mut bytes = vec![0; size];
    bytes[..4].copy_from_slice(b"dex\n");
    bytes[4..7].copy_from_slice(version);
    bytes[32..36].copy_from_slice(&(size as u32).to_le_bytes());
    bytes[36..40].copy_from_slice(&112u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&0x1234_5678u32.to_le_bytes());
    bytes
}

fn input(bytes: Vec<u8>) -> ArtifactStream {
    Box::pin(stream::iter(
        bytes
            .chunks(7)
            .map(|chunk| Ok(chunk.to_vec().into()))
            .collect::<Vec<_>>(),
    ))
}

#[tokio::test]
async fn chunked_dex_candidates_preserve_metadata_bytes_and_reject_zip_preview() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for version in [b"035", b"037", b"038", b"039", b"040"] {
        let bytes = candidate(version, 112);
        let artifact = store
            .put("classes.DEX".into(), input(bytes.clone()))
            .await
            .unwrap();
        assert_eq!(artifact.media_type, "application/vnd.android.dex");
        assert_eq!(artifact.size, 112);
        assert_eq!(
            store.get(&artifact.id).await.unwrap().sha256,
            artifact.sha256
        );
        let (_, mut output) = store.download(&artifact.id).await.unwrap();
        let mut received = Vec::new();
        while let Some(chunk) = output.next().await {
            received.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(received, bytes);
        assert!(matches!(
            store.archive_entries(&artifact.id, 0, 1).await,
            Err(Error::Invalid(_))
        ));
    }
}

#[tokio::test]
async fn unsupported_magic_length_header_and_endian_do_not_publish_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let original = candidate(b"039", 112);
    let mut cases = vec![
        Vec::new(),
        original[..111].to_vec(),
        candidate(b"036", 112),
        candidate(b"041", 112),
    ];
    for offset in [0, 7, 32, 36, 40] {
        let mut bytes = original.clone();
        bytes[offset] ^= 1;
        cases.push(bytes);
    }
    for bytes in cases {
        assert!(matches!(
            store.put("classes.dex".into(), input(bytes)).await,
            Err(Error::Invalid(_))
        ));
    }
    let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err());
    }
}

#[tokio::test]
async fn configured_dex_limit_rejects_during_streaming_before_content_qualification() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(directory.path(), 111)
        .await
        .unwrap();
    assert!(matches!(
        store
            .put("classes.dex".into(), input(candidate(b"039", 112)))
            .await,
        Err(Error::TooLarge)
    ));
}

#[tokio::test]
async fn larger_deployment_limit_keeps_the_independent_dex_format_limit() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(directory.path(), 128 * 1024 * 1024)
        .await
        .unwrap();
    let block = vec![0; 64 * 1024];
    let chunks: ArtifactStream = Box::pin(stream::iter(
        (0..1025).map(move |_| Ok(block.clone().into())),
    ));
    assert!(matches!(
        store.put("classes.dex".into(), chunks).await,
        Err(Error::TooLarge)
    ));
}
