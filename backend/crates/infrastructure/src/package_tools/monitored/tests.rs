//! 组件层以暂停时钟验证一次并发清理窗口；不替代真实进程黑盒验收。
use super::*;

#[tokio::test(start_paused = true)]
async fn cleanup_waits_concurrently_without_renewing_the_window() {
    let cancel = CancellationToken::new();
    let tool_stop = cancel.child_token();
    let monitor_stop = cancel.child_token();
    let start = Instant::now();
    let tool = async {
        tool_stop.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Err::<(), _>(Error::Cancelled)
    };
    let monitor = async {
        monitor_stop.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(())
    };
    cancel.cancel();
    // 预取消直接拒绝；运行中取消由下面的启动通知驱动。
    assert!(matches!(
        run(
            tool,
            monitor,
            &cancel,
            &tool_stop,
            &monitor_stop,
            start + Duration::from_secs(10)
        )
        .await,
        Err(Error::Cancelled)
    ));
    let cancel = CancellationToken::new();
    let tool_stop = cancel.child_token();
    let monitor_stop = cancel.child_token();
    let (started, received) = tokio::sync::oneshot::channel();
    let tool = async {
        let _ = started.send(());
        tool_stop.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Err::<(), _>(Error::Cancelled)
    };
    let monitor = async {
        monitor_stop.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(())
    };
    let trigger = async {
        received.await.unwrap();
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(
        run(
            tool,
            monitor,
            &cancel,
            &tool_stop,
            &monitor_stop,
            start + Duration::from_secs(10)
        ),
        trigger
    );
    assert!(matches!(result, Err(Error::Cancelled)));
    assert_eq!(Instant::now() - start, Duration::from_millis(1500));
}

#[tokio::test(start_paused = true)]
async fn a_hung_tool_does_not_receive_an_extra_window_after_monitor_exit() {
    let cancel = CancellationToken::new();
    let tool_stop = cancel.child_token();
    let monitor_stop = cancel.child_token();
    let start = Instant::now();
    let monitor = async {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Err(Error::Invalid("输出非法".into()))
    };
    let tool = std::future::pending::<Result<()>>();
    let result = run(
        tool,
        monitor,
        &cancel,
        &tool_stop,
        &monitor_stop,
        start + Duration::from_secs(10),
    )
    .await;
    assert!(matches!(result, Err(Error::CleanupFailed)));
    assert!(tool_stop.is_cancelled());
    assert_eq!(Instant::now() - start, Duration::from_millis(3500));
}

#[tokio::test]
async fn cleanup_failure_takes_precedence_over_monitor_validation_error() {
    let cancel = CancellationToken::new();
    let tool_stop = cancel.child_token();
    let monitor_stop = cancel.child_token();
    let tool = async {
        tool_stop.cancelled().await;
        Err::<(), _>(Error::CleanupFailed)
    };
    let monitor = async { Err(Error::Invalid("输出非法".into())) };
    assert!(matches!(
        run(
            tool,
            monitor,
            &cancel,
            &tool_stop,
            &monitor_stop,
            Instant::now() + Duration::from_secs(10)
        )
        .await,
        Err(Error::CleanupFailed)
    ));
}

#[tokio::test(start_paused = true)]
async fn tool_success_after_deadline_during_monitor_cleanup_is_rejected() {
    let cancel = CancellationToken::new();
    let tool_stop = cancel.child_token();
    let monitor_stop = cancel.child_token();
    let tool = async { Ok(()) };
    let monitor = async {
        monitor_stop.cancelled().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        Ok(())
    };
    assert!(matches!(
        run(
            tool,
            monitor,
            &cancel,
            &tool_stop,
            &monitor_stop,
            Instant::now() + Duration::from_millis(500)
        )
        .await,
        Err(Error::Timeout)
    ));
}
