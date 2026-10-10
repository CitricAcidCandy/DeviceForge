//! 停止信号必须进入在飞闭包；迟退出不释放许可或冒充清理成功。
use super::*;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn monitor_stop_reaches_running_control_before_total_deadline() {
    let owner = ContextOwner::start().await;
    let session = owner.session();
    let stop = CancellationToken::new();
    let (started, running) = tokio::sync::oneshot::channel();
    let work = session.work_stopping::<()>(stop.clone(), move |control| {
        started.send(()).unwrap();
        loop {
            control.check()?;
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => panic!("停止前不应返回：{result:?}"),
        result = running => result.unwrap(),
    }
    assert_eq!(session.slots.available_permits(), 0);
    assert_eq!(Arc::strong_count(&session.lease), 2);
    stop.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), &mut work)
            .await
            .unwrap(),
        Err(Error::Cancelled)
    ));
    assert!(session.context.check().is_ok());
    assert_eq!(session.slots.available_permits(), 1);
    assert_eq!(Arc::strong_count(&session.lease), 1);
    assert!(!session.unresolved.load(Ordering::Acquire));
    assert!(session.cleanup().await);
    owner.close().await;
}

#[tokio::test]
async fn late_worker_keeps_lease_and_permit_after_fixed_cleanup_point() {
    let owner = ContextOwner::start().await;
    let session = owner.session();
    let root = session.root.clone();
    let stop = CancellationToken::new();
    let (started, running) = tokio::sync::oneshot::channel();
    let (release, waiting) = std::sync::mpsc::channel();
    let work = session.work_stopping(stop.clone(), move |_| {
        started.send(()).unwrap();
        waiting.recv().unwrap();
        Ok(())
    });
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => panic!("放行前不应返回：{result:?}"),
        result = running => result.unwrap(),
    }
    // 提前设置已到的共同收口点，确定性验证不另授予两秒。
    *session.cleanup_until.lock().unwrap() = Some(tokio::time::Instant::now());
    stop.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), &mut work)
            .await
            .unwrap(),
        Err(Error::CleanupFailed)
    ));
    assert_eq!(session.slots.available_permits(), 0);
    assert_eq!(Arc::strong_count(&session.lease), 2);
    assert!(session.unresolved.load(Ordering::Acquire));
    assert!(!session.cleanup().await);
    assert!(tokio::fs::try_exists(&root).await.unwrap());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&session.lease) != 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(session.slots.available_permits(), 1);
    assert!(!session.cleanup().await);
    files::remove_owned(&root).unwrap();
    owner.close().await;
}
