use super::*;
use std::sync::{
    Condvar,
    atomic::{AtomicBool, Ordering},
};

struct ReleaseOnDrop(Arc<(Mutex<bool>, Condvar)>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let (lock, signal) = &*self.0;
        *lock.lock().unwrap() = true;
        signal.notify_all();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_waiters_and_dropped_requests_keep_real_slots_and_directory_leases() {
    let pool = Pool::default();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let _release_on_failure = ReleaseOnDrop(release.clone());
    let directory = Arc::new(crate::artifact_files::Temporary::new().unwrap());
    let path = directory.path().to_path_buf();
    let mut tasks = Vec::new();
    let mut ready = Vec::new();
    for _ in 0..4 {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        ready.push(receiver);
        let pool = pool.clone();
        let release = release.clone();
        let lease = directory.clone();
        tasks.push(tokio::spawn(async move {
            pool.run(CancellationToken::new(), None, move |_control| {
                let _lease = lease;
                sender.send(()).unwrap();
                let (lock, signal) = &*release;
                let mut done = lock.lock().unwrap();
                while !*done {
                    done = signal.wait(done).unwrap();
                }
                Ok(())
            })
            .await
        }));
    }
    for started in ready {
        tokio::time::timeout(std::time::Duration::from_secs(5), started)
            .await
            .unwrap()
            .unwrap();
    }
    drop(directory);
    assert_eq!(pool.slots.available_permits(), 0);
    assert!(!pool.unresolved(), "正常进行中的其他工作不是未确认清理");

    let invoked = Arc::new(AtomicBool::new(false));
    let cancel = CancellationToken::new();
    let observed = invoked.clone();
    let waiting = pool.run(cancel.clone(), None, move |_| {
        observed.store(true, Ordering::SeqCst);
        Ok(())
    });
    tokio::pin!(waiting);
    tokio::select! {
        biased;
        result = &mut waiting => panic!("四个真实槽占满后新工作不能完成：{result:?}"),
        _ = tokio::task::yield_now() => (),
    }
    cancel.cancel();
    assert!(matches!(waiting.await, Err(Error::Cancelled)));
    assert!(!invoked.load(Ordering::SeqCst));
    assert_eq!(pool.slots.available_permits(), 0);

    let abandoned = tasks.remove(0);
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    assert!(pool.unresolved());
    assert!(path.exists(), "丢弃请求不能回收真实工作仍持有的目录");
    assert_eq!(pool.slots.available_permits(), 0);

    let (lock, signal) = &*release;
    *lock.lock().unwrap() = true;
    signal.notify_all();
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while pool.unresolved() || pool.slots.available_permits() != 4 || path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("真实工作结束后许可、未确认状态和目录必须排空");
}

#[tokio::test]
async fn expired_original_deadline_never_starts_a_worker_even_with_free_capacity() {
    let pool = Pool::default();
    let invoked = Arc::new(AtomicBool::new(false));
    let observed = invoked.clone();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = pool
        .run(
            cancel,
            Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
            move |_| {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(!invoked.load(Ordering::SeqCst));
    assert_eq!(pool.slots.available_permits(), 4);
    assert!(!pool.unresolved());
}
