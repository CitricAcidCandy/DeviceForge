//! 以真实阻塞闭包和目录验证创建、取消及交接丢弃窗口。
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn directory(parent: &std::path::Path) -> Result<TempDir> {
    tempfile::Builder::new()
        .prefix("deviceforge-android-packages-")
        .tempdir_in(parent)
        .map_err(|_| Error::Io("测试目录创建失败"))
}

#[tokio::test]
async fn cancelled_before_enqueue_never_creates_directory() {
    let touched = Arc::new(AtomicBool::new(false));
    let used = touched.clone();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = create_with(
        Instant::now() + Duration::from_secs(30),
        cancel,
        move || {
            used.store(true, Ordering::Release);
            Err(Error::Io("不应执行创建闭包"))
        },
    )
    .await;
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(!touched.load(Ordering::Acquire));
}

#[tokio::test]
async fn expired_before_enqueue_never_creates_directory() {
    let touched = Arc::new(AtomicBool::new(false));
    let used = touched.clone();
    let result = create_with(Instant::now(), CancellationToken::new(), move || {
        used.store(true, Ordering::Release);
        Err(Error::Io("不应执行创建闭包"))
    })
    .await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(!touched.load(Ordering::Acquire));
}

#[tokio::test]
async fn dropped_wait_during_creation_keeps_cleanup_owner() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().to_path_buf();
    let (created, observed) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let task = tokio::spawn(create_with(
        Instant::now() + Duration::from_secs(30),
        CancellationToken::new(),
        move || {
            let owned = directory(&root)?;
            created.send(owned.path().to_path_buf()).unwrap();
            released.recv().unwrap();
            Ok(owned)
        },
    ));
    let path = observed.await.unwrap();
    assert!(tokio::fs::try_exists(&path).await.unwrap());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while tokio::fs::try_exists(&path).await.unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_after_creation_confirms_directory_removed() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().to_path_buf();
    let cancel = CancellationToken::new();
    let caller = cancel.clone();
    let (created, observed) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let task = tokio::spawn(create_with(
        Instant::now() + Duration::from_secs(30),
        caller,
        move || {
            let owned = directory(&root)?;
            created.send(owned.path().to_path_buf()).unwrap();
            released.recv().unwrap();
            Ok(owned)
        },
    ));
    let path = observed.await.unwrap();
    cancel.cancel();
    release.send(()).unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    assert!(!tokio::fs::try_exists(path).await.unwrap());
}
