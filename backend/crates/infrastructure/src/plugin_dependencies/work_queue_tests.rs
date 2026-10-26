//! 并发读仅有限等待，队列溢出与耗尽预算仍如实失败。
use super::*;

#[tokio::test]
async fn parallel_dependency_reads_wait_instead_of_conflicting() {
    let (_temporary, store) = tests::fixture().await;
    let target = tests::deploy(&store, "parallel-reader", Vec::new());
    let occupied = store.workers.clone().acquire_many_owned(2).await.unwrap();
    let mut readers = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let store = store.clone();
        let target = target.clone();
        readers.spawn(async move { store.get(target).await });
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(readers.try_join_next().is_none());
    drop(occupied);
    while let Some(result) = readers.join_next().await {
        assert!(result.unwrap().unwrap().ready);
    }
    assert_eq!(store.workers.available_permits(), 2);
    assert_eq!(store.work_queue.available_permits(), 64);
}

#[tokio::test]
async fn worker_waiting_has_a_capacity_and_deadline() {
    let (_temporary, store) = tests::fixture().await;
    let full = store
        .work_queue
        .clone()
        .acquire_many_owned(64)
        .await
        .unwrap();
    assert!(matches!(
        store.work(|_| Ok(())).await,
        Err(Error::Conflict(_))
    ));
    drop(full);
    let occupied = store.workers.clone().acquire_many_owned(2).await.unwrap();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(4), store.work(|_| Ok(())))
        .await
        .expect("工作槽等待必须有界");
    assert!(matches!(result, Err(Error::Conflict(_))));
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert_eq!(store.work_queue.available_permits(), 64);
    drop(occupied);
    store.work(|_| Ok(())).await.unwrap();
}
