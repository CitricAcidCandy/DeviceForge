//! 产物资源边界独立验收：本文件只调用公开 `FileArtifacts`/`ArtifactStore`。
//!
//! 当前接口可验证单文件限额、总配额、按字节上传预留、上传并发名额、读写租约、
//! 删除释放、保留期限回收和重启扫描；未知或损坏目录只作为诊断信息保留。

use apk_domain::{
    Error,
    artifacts::{ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use futures_util::{StreamExt, stream};
use std::{path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

fn input(bytes: impl Into<Vec<u8>> + Send + 'static) -> ArtifactStream {
    Box::pin(stream::once(async move { Ok(bytes.into().into()) }))
}

fn zip_input() -> Vec<u8> {
    use std::io::{Cursor, Write};
    use zip::{ZipWriter, write::SimpleFileOptions};

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("entry.txt", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"deviceforge").unwrap();
    writer.finish().unwrap().into_inner()
}

async fn exists(path: impl AsRef<Path>) -> bool {
    tokio::fs::try_exists(path).await.unwrap()
}

#[tokio::test]
async fn single_file_limit_and_error_mapping_are_exact() {
    let directory = tempfile::tempdir().unwrap();
    assert!(matches!(
        FileArtifacts::with_limit(directory.path(), 0).await,
        Err(Error::Invalid(_))
    ));
    let store = FileArtifacts::with_limit(directory.path(), 8)
        .await
        .unwrap();
    let item = store
        .put("small.bin".into(), input([0_u8; 8]))
        .await
        .unwrap();
    assert_eq!(item.size, 8);
    assert!(matches!(
        store.put("large.bin".into(), input([0_u8; 9])).await,
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        store.put("invalid.txt".into(), input([0_u8; 1])).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.get("not-an-id").await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.get("00000000-0000-0000-0000-000000000001").await,
        Err(Error::NotFound(_))
    ));
    assert!(exists(directory.path().join(item.id)).await);
}

#[tokio::test]
async fn active_downloads_share_reader_capacity_and_block_delete() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let item = store
        .put("shared.bin".into(), input([7_u8; 32]))
        .await
        .unwrap();
    let mut readers = Vec::new();
    for _ in 0..8 {
        readers.push(store.download(&item.id).await.unwrap());
    }
    assert!(matches!(
        store.download(&item.id).await,
        Err(Error::Conflict(message)) if message == "并发下载已满"
    ));
    assert!(matches!(
        store.archive_entries(&item.id, 0, 1).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.delete(&item.id).await,
        Err(Error::Conflict(message)) if message == "产物正在被读取或预览"
    ));
    drop(readers);
    let deleted = store.delete(&item.id).await.unwrap();
    assert_eq!(deleted.id, item.id);
    assert!(!exists(directory.path().join(&item.id)).await);
    assert!(matches!(store.get(&item.id).await, Err(Error::NotFound(_))));
}

#[tokio::test]
async fn preview_uses_shared_capacity_and_recovers_after_readers_release() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let item = store
        .put("entries.zip".into(), input(zip_input()))
        .await
        .unwrap();
    let mut readers = Vec::new();
    for _ in 0..8 {
        readers.push(store.download(&item.id).await.unwrap());
    }
    assert!(matches!(
        store.archive_entries(&item.id, 0, 1).await,
        Err(Error::Conflict(message)) if message == "并发预览已满"
    ));
    drop(readers);
    let page = store.archive_entries(&item.id, 0, 1).await.unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].name, "entry.txt");
}

#[tokio::test]
async fn upload_slots_are_reserved_before_streaming_and_released_on_cancel() {
    use std::sync::Arc;
    use tokio::sync::Notify;

    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let mut handles = Vec::new();
    for index in 0..4 {
        let notify = Arc::new(Notify::new());
        let signal = notify.clone();
        let incoming = Box::pin(
            stream::once(async move {
                signal.notify_one();
                Ok(vec![index as u8].into())
            })
            .chain(stream::pending()),
        );
        let writer = store.clone();
        handles.push((
            notify,
            tokio::spawn(async move { writer.put(format!("held-{index}.bin"), incoming).await }),
        ));
    }
    for (notify, _) in &handles {
        notify.notified().await;
    }
    assert!(matches!(
        store
            .put("fifth.bin".into(), input([0_u8; 1]))
            .await,
        Err(Error::Conflict(message)) if message == "并发上传已满"
    ));
    let (_, cancelled) = handles.pop().unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert!(
        store
            .put("replacement.bin".into(), input([1_u8; 1]))
            .await
            .is_ok()
    );
    for (_, handle) in handles {
        handle.abort();
        let _ = handle.await;
    }
}

#[tokio::test]
async fn restart_cleans_owned_staging_but_preserves_diagnostics_and_valid_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let valid = store
        .put("valid.bin".into(), input([1_u8; 4]))
        .await
        .unwrap();
    drop(store);

    let staging = directory.path().join(".staging");
    let stale = staging.join("00000000-0000-0000-0000-000000000002");
    tokio::fs::create_dir_all(&stale).await.unwrap();
    tokio::fs::write(stale.join("content"), b"unfinished")
        .await
        .unwrap();
    let diagnostic = staging.join("manual-diagnostic");
    tokio::fs::create_dir_all(&diagnostic).await.unwrap();
    tokio::fs::write(diagnostic.join("note"), b"keep for diagnosis")
        .await
        .unwrap();

    let bad_id = "00000000-0000-0000-0000-000000000003";
    let bad_artifact = directory.path().join(bad_id);
    tokio::fs::create_dir_all(&bad_artifact).await.unwrap();
    tokio::fs::write(bad_artifact.join("content"), b"bytes")
        .await
        .unwrap();
    tokio::fs::write(bad_artifact.join("metadata.json"), b"{broken")
        .await
        .unwrap();

    let reopened = FileArtifacts::open(directory.path()).await.unwrap();
    assert_eq!(reopened.get(&valid.id).await.unwrap().size, 4);
    assert!(!exists(stale).await);
    assert!(exists(diagnostic).await);
    assert!(exists(&bad_artifact).await);
    assert!(matches!(reopened.get(bad_id).await, Err(Error::Storage(_))));
    assert!(matches!(
        reopened.delete(bad_id).await,
        Err(Error::Storage(_))
    ));
    assert!(exists(bad_artifact).await);
}

#[tokio::test]
async fn content_digest_mismatch_is_rejected_without_leaking_reader_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::open(directory.path()).await.unwrap();
    let item = store
        .put("tampered.bin".into(), input([1_u8; 4]))
        .await
        .unwrap();
    tokio::fs::write(directory.path().join(&item.id).join("content"), [2_u8; 4])
        .await
        .unwrap();

    assert!(matches!(
        store.get(&item.id).await,
        Err(Error::Storage(message)) if message == "产物内容摘要不匹配"
    ));
    assert!(matches!(
        store.download(&item.id).await,
        Err(Error::Storage(message)) if message == "产物内容摘要不匹配"
    ));
    tokio::fs::write(directory.path().join(&item.id).join("content"), [1_u8; 4])
        .await
        .unwrap();
    assert_eq!(store.download(&item.id).await.unwrap().0.id, item.id);
}

#[tokio::test]
async fn restart_skips_digest_mismatch_when_rebuilding_quota() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limits(directory.path(), 4, 4, None)
        .await
        .unwrap();
    let item = store
        .put("corrupted.bin".into(), input([3_u8; 4]))
        .await
        .unwrap();
    drop(store);

    tokio::fs::write(directory.path().join(&item.id).join("content"), [4_u8; 4])
        .await
        .unwrap();
    let reopened = FileArtifacts::with_limits(directory.path(), 4, 4, None)
        .await
        .unwrap();
    assert!(matches!(
        reopened.get(&item.id).await,
        Err(Error::Storage(message)) if message == "产物内容摘要不匹配"
    ));
    assert!(
        reopened
            .put("replacement.bin".into(), input([5_u8; 1]))
            .await
            .is_ok()
    );
    assert!(exists(directory.path().join(&item.id)).await);
}

#[tokio::test]
async fn total_quota_rejects_committed_overflow_and_releases_after_delete() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limits(directory.path(), 8, 8, None)
        .await
        .unwrap();
    let first = store
        .put("first.bin".into(), input([1_u8; 8]))
        .await
        .unwrap();
    assert!(matches!(
        store.put("second.bin".into(), input([2_u8; 1])).await,
        Err(Error::TooLarge)
    ));
    store.delete(&first.id).await.unwrap();
    assert!(
        store
            .put("second.bin".into(), input([2_u8; 1]))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn cancelled_upload_releases_byte_reservation_for_replacement() {
    use std::sync::Arc;
    use tokio::sync::Notify;

    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FileArtifacts::with_limits(directory.path(), 8, 8, None)
            .await
            .unwrap(),
    );
    let notify = Arc::new(Notify::new());
    let signal = notify.clone();
    let incoming = Box::pin(
        stream::once(async move {
            signal.notify_one();
            Ok(vec![3_u8; 6].into())
        })
        .chain(stream::pending()),
    );
    let writer = store.clone();
    let pending = tokio::spawn(async move { writer.put("cancelled.bin".into(), incoming).await });
    notify.notified().await;
    assert!(matches!(
        store.put("blocked.bin".into(), input([4_u8; 3])).await,
        Err(Error::Conflict(_))
    ));
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert!(
        store
            .put("replacement.bin".into(), input([4_u8; 3]))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn expired_artifacts_are_reclaimed_after_active_reader_releases() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limits(directory.path(), 32, 64, Some(1))
        .await
        .unwrap();
    let expired = store
        .put("expired.bin".into(), input([5_u8; 4]))
        .await
        .unwrap();
    let retained = store
        .put("retained.bin".into(), input([6_u8; 4]))
        .await
        .unwrap();
    let metadata_path = directory.path().join(&expired.id).join("metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    metadata["created_at"] = serde_json::json!(0);
    tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();
    let (_metadata, reader) = store.download(&expired.id).await.unwrap();
    let skipped = store.maintain().await.unwrap();
    assert_eq!(skipped.removed, 0);
    assert_eq!(skipped.skipped_active, 1);
    drop(reader);
    let report = store.cleanup_expired().await.unwrap();
    assert_eq!(report.removed, 1);
    assert_eq!(report.released_bytes, expired.size);
    assert!(matches!(
        store.get(&expired.id).await,
        Err(Error::NotFound(_))
    ));
    assert_eq!(store.get(&retained.id).await.unwrap().id, retained.id);
}

#[tokio::test]
async fn retention_worker_reclaims_expired_artifacts_and_stops() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FileArtifacts::with_limits(directory.path(), 32, 64, Some(1))
            .await
            .unwrap(),
    );
    let expired = store
        .put("worker.bin".into(), input([8_u8; 4]))
        .await
        .unwrap();
    let metadata_path = directory.path().join(&expired.id).join("metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    metadata["created_at"] = serde_json::json!(0);
    tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();

    let shutdown = CancellationToken::new();
    let worker = store.spawn_retention_worker(shutdown.clone()).unwrap();
    for _ in 0..8 {
        if matches!(store.get(&expired.id).await, Err(Error::NotFound(_))) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(matches!(
        store.get(&expired.id).await,
        Err(Error::NotFound(_))
    ));
    shutdown.cancel();
    worker.shutdown().await;
}

#[tokio::test]
async fn maintenance_cancellation_stops_before_scanning_entries() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileArtifacts::with_limits(directory.path(), 32, 64, Some(1))
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        store.maintain_with_cancel(&cancel).await,
        Err(Error::Cancelled)
    ));
}

#[test]
fn artifact_boundary_errors_keep_public_codes() {
    let cases = [
        (Error::Invalid("输入".into()), "invalid_input"),
        (Error::TooLarge, "payload_too_large"),
        (Error::Conflict("占用".into()), "conflict"),
        (Error::NotFound("id".into()), "not_found"),
        (Error::Storage("元数据".into()), "storage_failed"),
        (Error::Timeout, "timeout"),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
    }
}
