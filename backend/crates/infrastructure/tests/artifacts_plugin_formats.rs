use apk_domain::{
    Error,
    artifacts::{ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};
use sha2::{Digest, Sha256};

fn input(bytes: Vec<u8>) -> ArtifactStream {
    Box::pin(stream::iter(
        bytes
            .chunks(7)
            .map(|chunk| Ok(chunk.to_vec().into()))
            .collect::<Vec<_>>(),
    ))
}

async fn assert_unpublished(directory: &std::path::Path) {
    let mut entries = tokio::fs::read_dir(directory).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err());
    }
}

#[tokio::test]
async fn plugin_formats_preserve_case_insensitive_types_original_bytes_and_digest() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for (filename, media_type, bytes) in [
        ("server.BIN", "application/octet-stream", vec![0, 255, 128]),
        (
            "script.JS",
            "text/javascript",
            "const 文本 = '设备';".as_bytes().to_vec(),
        ),
        ("stderr.LOG", "text/plain", vec![255, 0, 128]),
        ("empty.log", "text/plain", Vec::new()),
        (
            "events.JSONL",
            "application/x-ndjson",
            "{\"设备\":1}\r\nnull\n".as_bytes().to_vec(),
        ),
        ("empty.jsonl", "application/x-ndjson", Vec::new()),
        ("record.MP4", "video/mp4", b"\0\0\0\x18ftypisom".to_vec()),
    ] {
        let artifact = store
            .put(filename.into(), input(bytes.clone()))
            .await
            .unwrap();
        assert_eq!(artifact.media_type, media_type);
        assert_eq!(artifact.filename, filename);
        assert_eq!(artifact.size, bytes.len() as u64);
        assert_eq!(artifact.sha256, format!("{:x}", Sha256::digest(&bytes)));
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
async fn scripts_and_jsonl_accept_utf8_characters_crossing_validation_buffers() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let mut script = vec![b' '; 64 * 1024 - 1];
    script.extend_from_slice("设备".as_bytes());
    script.extend_from_slice(&vec![b' '; 64 * 1024 - 1]);
    script.extend_from_slice("工坊".as_bytes());
    let mut jsonl = vec![b' '; 64 * 1024 - 2];
    jsonl.extend_from_slice("\"设备\"\n{\"后续\":true}".as_bytes());
    for (filename, bytes) in [("boundary.js", script), ("boundary.jsonl", jsonl)] {
        let artifact = store
            .put(filename.into(), input(bytes.clone()))
            .await
            .unwrap();
        assert_eq!(artifact.sha256, format!("{:x}", Sha256::digest(bytes)));
    }
}

#[tokio::test]
async fn empty_binary_bad_script_and_truncated_utf8_do_not_publish() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let mut boundary = vec![b' '; 64 * 1024 - 1];
    boundary.extend_from_slice(&[0xe8, 0x80]);
    for (filename, bytes) in [
        ("empty.bin", Vec::new()),
        ("empty.js", Vec::new()),
        ("nul.js", b"const value = 1;\0".to_vec()),
        ("invalid.js", vec![0xff]),
        ("truncated.js", vec![0xe8, 0x80]),
        ("boundary.js", boundary),
    ] {
        assert!(matches!(
            store.put(filename.into(), input(bytes)).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_unpublished(directory.path()).await;
}

#[tokio::test]
async fn malformed_jsonl_lines_utf8_duplicates_and_blank_lines_do_not_publish() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for bytes in [
        b"{}\nnot-json\n{}".to_vec(),
        b"{}\n\n{}".to_vec(),
        b" \n".to_vec(),
        b"{\"same\":1,\"same\":2}\n".to_vec(),
        vec![b'"', 0xff, b'"'],
        b"{}\n{\"text\":\"unfinished".to_vec(),
    ] {
        assert!(matches!(
            store.put("events.jsonl".into(), input(bytes)).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_unpublished(directory.path()).await;
}

#[tokio::test]
async fn jsonl_line_limit_rejects_even_when_total_file_is_within_deployment_limit() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let block = vec![b' '; 64 * 1024];
    let chunks: ArtifactStream = Box::pin(stream::iter(
        (0..257).map(move |_| Ok(block.clone().into())),
    ));
    assert!(matches!(
        store.put("long.jsonl".into(), chunks).await,
        Err(Error::TooLarge)
    ));
    assert_unpublished(directory.path()).await;
}

#[tokio::test]
async fn lower_deployment_limit_stops_stream_before_next_chunk_for_all_new_formats() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(directory.path(), 12)
        .await
        .unwrap();
    for filename in [
        "server.bin",
        "script.js",
        "stderr.log",
        "events.jsonl",
        "record.mp4",
    ] {
        let chunks: ArtifactStream = Box::pin(stream::iter(vec![
            Ok(vec![0; 13].into()),
            Err(Error::Dependency("不应读取后续分块".into())),
        ]));
        assert!(matches!(
            store.put(filename.into(), chunks).await,
            Err(Error::TooLarge)
        ));
    }
    assert_unpublished(directory.path()).await;
}

#[tokio::test]
async fn truncated_or_invalid_mp4_header_does_not_publish() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for bytes in [
        Vec::new(),
        b"\0\0\0\x18ftypiso".to_vec(),
        b"\0\0\0\x18failisom".to_vec(),
        b"\0\0\0\x0bftypisom".to_vec(),
    ] {
        assert!(matches!(
            store.put("record.mp4".into(), input(bytes)).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_unpublished(directory.path()).await;
}

#[tokio::test]
async fn larger_deployment_limit_keeps_log_streams_bounded_at_the_format_limit() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(directory.path(), 128 * 1024 * 1024)
        .await
        .unwrap();
    let block = vec![0xff; 64 * 1024];
    let chunks: ArtifactStream = Box::pin(stream::iter(
        (0..1025).map(move |_| Ok(block.clone().into())),
    ));
    assert!(matches!(
        store.put("stderr.log".into(), chunks).await,
        Err(Error::TooLarge)
    ));
    assert_unpublished(directory.path()).await;
}
