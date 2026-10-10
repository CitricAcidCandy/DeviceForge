//! 公开存储等待者被丢弃后，实际阻塞工作继续持有存储槽。
use super::{
    clock::{paused_future, paused_until, poll_once, settle},
    fixture::Fixture,
};

#[tokio::test(start_paused = true)]
async fn aborted_storage_waiters_do_not_release_slots_before_real_work_ends() {
    let fixture = Fixture::new(Some(30_000), 1);
    let readers = fixture.fill_storage().await;
    assert_eq!(fixture.store.listing.entered(), 4);
    assert_eq!(fixture.store.listing.exited(), 0);
    for task in &readers {
        task.abort();
    }
    paused_until("异步等待者已丢弃", || {
        readers
            .iter()
            .all(tokio::task::JoinHandle::is_finished)
            .then_some(())
    })
    .await;
    for task in readers {
        assert!(task.await.unwrap_err().is_cancelled());
    }
    let fifth = fixture.app.list_async(16);
    tokio::pin!(fifth);
    assert!(poll_once(fifth.as_mut()).await.is_none());
    settle().await;
    assert_eq!(
        fixture.store.listing.entered(),
        4,
        "第五个实际工作不能借用提前归还的许可"
    );
    assert_eq!(fixture.store.listing.exited(), 0);
    fixture.store.listing.release();
    assert!(
        paused_future("实际工作结束后第五个请求获槽", fifth.as_mut())
            .await
            .unwrap()
            .is_empty()
    );
    paused_until("五个真实列表工作均离开门闩", || {
        (fixture.store.listing.exited() == 5).then_some(())
    })
    .await;
    assert_eq!(fixture.store.listing.entered(), 5);
    assert_eq!(fixture.store.listing.exited(), 5);
    fixture.shutdown().await;
}
