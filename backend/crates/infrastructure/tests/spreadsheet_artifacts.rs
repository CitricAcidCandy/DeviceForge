use apk_domain::{Error, artifacts::ArtifactStore};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};
use std::io::{Cursor, Write};

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

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[tokio::test]
async fn spreadsheet_envelopes_preserve_bytes_and_distinct_media_types() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    // 这里只验证XLS容器最低资格，不把此头部夹具视为可解析的BIFF工作簿。
    let mut cfb = vec![0; 1024];
    cfb[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    cfb[26..34].copy_from_slice(&[3, 0, 0xfe, 0xff, 9, 0, 6, 0]);
    let xlsx = archive(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("_rels/.rels", b"<Relationships/>"),
        ("xl/workbook.xml", b"<workbook/>"),
    ]);
    for (name, media_type, bytes) in [
        (
            "数据.XLSX",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            xlsx,
        ),
        ("旧表.xls", "application/vnd.ms-excel", cfb),
        (
            "中文.csv",
            "text/csv",
            "\u{feff}姓名,值\r\n中文,0\r\n".as_bytes().to_vec(),
        ),
    ] {
        let artifact = put(&store, name, bytes.clone()).await.unwrap();
        assert_eq!(artifact.media_type, media_type);
        let (_, mut stream) = store.download(&artifact.id).await.unwrap();
        let mut downloaded = Vec::new();
        while let Some(chunk) = stream.next().await {
            downloaded.extend(chunk.unwrap());
        }
        assert_eq!(downloaded, bytes);
        assert!(matches!(
            store.archive_entries(&artifact.id, 0, 1).await,
            Err(Error::Invalid(_))
        ));
    }
}

#[tokio::test]
async fn spreadsheet_invalid_envelopes_are_never_published() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for (name, bytes) in [
        ("bad.xlsx", archive(&[("file", b"not a workbook")])),
        ("bad.xlsx", archive(&[("../bad", b"x")])),
        ("bad.xlsx", b"not zip".to_vec()),
        ("bad.xls", vec![0; 1024]),
        ("bad.xls", vec![0xd0; 8]),
        ("bad.csv", vec![0xff]),
        ("bad.csv", b"a,b\n0,\0".to_vec()),
        ("empty.csv", Vec::new()),
    ] {
        assert!(matches!(
            put(&store, name, bytes).await,
            Err(Error::Invalid(_))
        ));
    }
    let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(entry.file_name().to_string_lossy().starts_with('.'));
    }
}

#[tokio::test]
async fn spreadsheet_stream_limit_rejects_without_waiting_for_next_chunk() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    for name in ["large.xlsx", "large.xls", "large.csv"] {
        let incoming = stream::once(async { Ok(vec![0; 16 * 1024 * 1024 + 1].into()) })
            .chain(stream::pending());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            store.put(name.into(), Box::pin(incoming)),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::TooLarge)));
    }
}

#[tokio::test]
async fn csv_utf8_across_buffer_boundary_and_truncated_tail_are_distinct() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let mut bytes = vec![b'a'; 64 * 1024 - 1];
    bytes.extend("中文".as_bytes());
    put(&store, "boundary.csv", bytes.clone()).await.unwrap();
    bytes.pop();
    assert!(matches!(
        put(&store, "truncated.csv", bytes).await,
        Err(Error::Invalid(_))
    ));
}
