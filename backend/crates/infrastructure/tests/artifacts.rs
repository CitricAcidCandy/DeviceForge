use apk_domain::{
    Error,
    artifacts::{ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};
use std::{
    io::{Cursor, Write},
    sync::Arc,
};
use tokio::sync::Notify;
use zip::{ZipWriter, write::SimpleFileOptions};
fn archive(names: &[&str]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for name in names {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"deviceforge").unwrap();
    }
    writer.finish().unwrap().into_inner()
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
async fn streaming_roundtrip_metadata_preview_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(dir.path()).await.unwrap();
    let bytes = archive(&["AndroidManifest.xml", "classes.dex"]);
    let item = store
        .put("中文应用.apk".into(), input(bytes.clone()))
        .await
        .unwrap();
    assert_eq!(item.size, bytes.len() as u64);
    assert_eq!(item.sha256.len(), 64);
    let (_, mut stream) = store.download(&item.id).await.unwrap();
    let mut received = Vec::new();
    while let Some(chunk) = stream.next().await {
        received.extend(chunk.unwrap());
    }
    assert_eq!(received, bytes);
    drop(stream);
    let page = store.archive_entries(&item.id, 0, 1).await.unwrap();
    assert_eq!(page.entries[0].name, "AndroidManifest.xml");
    assert_eq!(page.next_offset, Some(1));
    assert_eq!(
        store.archive_entries(&item.id, 1, 1).await.unwrap().entries[0].name,
        "classes.dex"
    );
    assert!(matches!(
        store.archive_entries(&item.id, 0, 201).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.archive_entries(&item.id, 3, 1).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        FileArtifacts::open(dir.path()).await,
        Err(Error::Conflict(_))
    ));
    drop(store);
    let reopened = FileArtifacts::open(dir.path()).await.unwrap();
    assert_eq!(reopened.get(&item.id).await.unwrap().sha256, item.sha256);
}
#[tokio::test]
async fn rejected_inputs_and_traversal_never_publish() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limit(dir.path(), 1024).await.unwrap();
    for name in [
        "../a.apk",
        "C:\\a.apk",
        "a\nb.apk",
        "a.exe",
        ".apk",
        "a.apk.",
    ] {
        assert!(matches!(
            store.put(name.into(), input(archive(&["safe"]))).await,
            Err(Error::Invalid(_))
        ));
    }
    for name in ["../escape", "/absolute", "C:/absolute", "folder\\escape"] {
        assert!(matches!(
            store.put("a.zip".into(), input(archive(&[name]))).await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(matches!(
        store
            .put("fake.apk".into(), input(b"not zip".to_vec()))
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .put("fake.png".into(), input(b"not png".to_vec()))
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.put("large.apk".into(), input(vec![0; 1025])).await,
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        store.get("../../secret").await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.get("00000000-0000-0000-0000-000000000000").await,
        Err(Error::NotFound(_))
    ));
    let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(entry.file_name().to_string_lossy().starts_with('.'));
    }
}
#[tokio::test]
async fn cancelled_upload_is_not_visible_and_recovery_cleans_staging() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(dir.path()).await.unwrap());
    let notified = Arc::new(Notify::new());
    let signal = notified.clone();
    let incoming = Box::pin(
        stream::once(async move {
            signal.notify_one();
            Ok(b"PK".to_vec().into())
        })
        .chain(stream::pending()),
    );
    let worker_store = store.clone();
    let handle =
        tokio::spawn(async move { worker_store.put("cancelled.apk".into(), incoming).await });
    notified.notified().await;
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    drop(store);
    // 模拟进程崩溃遗留目录，重启只删除自己命名空间中的临时上传。
    let stale = dir
        .path()
        .join(".staging/00000000-0000-0000-0000-000000000001");
    tokio::fs::create_dir_all(&stale).await.unwrap();
    tokio::fs::write(stale.join("content"), b"partial")
        .await
        .unwrap();
    let reopened = FileArtifacts::open(dir.path()).await.unwrap();
    assert!(!stale.exists());
    assert!(
        reopened
            .get("00000000-0000-0000-0000-000000000001")
            .await
            .is_err()
    );
}
#[tokio::test]
async fn interrupted_stream_and_download_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(dir.path()).await.unwrap();
    let failed = Box::pin(stream::iter(vec![
        Ok(b"PK".to_vec().into()),
        Err(Error::Invalid("连接中断".into())),
    ]));
    assert!(store.put("broken.zip".into(), failed).await.is_err());
    let item = store
        .put("valid.zip".into(), input(archive(&["safe"])))
        .await
        .unwrap();
    let mut readers = Vec::new();
    for _ in 0..8 {
        readers.push(store.download(&item.id).await.unwrap());
    }
    assert!(matches!(
        store.download(&item.id).await,
        Err(Error::Conflict(_))
    ));
    readers.pop();
    assert!(store.download(&item.id).await.is_ok());
}

#[tokio::test]
async fn upload_concurrency_is_bounded_and_cancel_releases_slots() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(dir.path()).await.unwrap());
    let mut handles = Vec::new();
    for _ in 0..4 {
        let notified = Arc::new(Notify::new());
        let signal = notified.clone();
        let incoming = Box::pin(
            stream::once(async move {
                signal.notify_one();
                Ok(b"PK".to_vec().into())
            })
            .chain(stream::pending()),
        );
        let writer = store.clone();
        handles.push(tokio::spawn(async move {
            writer.put("pending.zip".into(), incoming).await
        }));
        notified.notified().await;
    }
    assert!(matches!(
        store
            .put("fifth.zip".into(), input(archive(&["safe"])))
            .await,
        Err(Error::Conflict(_))
    ));
    let handle = handles.pop().unwrap();
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    assert!(
        store
            .put("replacement.zip".into(), input(archive(&["safe"])))
            .await
            .is_ok()
    );
    for handle in handles {
        handle.abort();
        let _ = handle.await;
    }
}

#[tokio::test]
async fn forged_directory_count_is_rejected_before_archive_allocation() {
    let dir = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(dir.path()).await.unwrap();
    let mut bytes = archive(&["safe"]);
    let footer = bytes.len() - 22;
    bytes[footer + 8..footer + 10].copy_from_slice(&20_000u16.to_le_bytes());
    bytes[footer + 10..footer + 12].copy_from_slice(&20_000u16.to_le_bytes());
    assert!(matches!(
        store.put("forged.zip".into(), input(bytes)).await,
        Err(Error::Invalid(_))
    ));
}
