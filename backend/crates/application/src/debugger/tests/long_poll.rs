//! 长轮询只使用调用 Future 内的有界计时器和通知，不产生常驻任务。

use super::*;

#[tokio::test(start_paused = true)]
async fn debugger_poll_without_sessions_returns_immediately_and_active_poll_is_bounded() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let started = tokio::time::Instant::now();
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .active_sessions
            .is_empty()
    );
    assert_eq!(started.elapsed(), Duration::ZERO);
    open(&service, &instance);
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    assert_eq!(started.elapsed(), Duration::from_secs(2));
}

#[tokio::test(start_paused = true)]
async fn debugger_poll_is_woken_by_enqueue_close_and_disconnect_without_background_tasks() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let started = tokio::time::Instant::now();
    let (batch, ()) = tokio::join!(biased; service.poll(poll(&instance)), async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        service.enqueue(request(&session)).unwrap();
    });
    assert_eq!(batch.unwrap().commands.len(), 1);
    assert_eq!(started.elapsed(), Duration::from_millis(10));
    let (batch, ()) = tokio::join!(biased; service.poll(poll(&instance)), async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        service.close_session(&session.session_id).unwrap();
    });
    assert!(batch.unwrap().active_sessions.is_empty());
    assert_eq!(started.elapsed(), Duration::from_millis(20));
    open(&service, &instance);
    let (batch, ()) = tokio::join!(biased; service.poll(poll(&instance)), async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        service.disconnect(&instance.instance_id).unwrap();
    });
    assert_eq!(batch.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(started.elapsed(), Duration::from_millis(30));
}

#[tokio::test(start_paused = true)]
async fn debugger_poll_observes_session_ttl_before_two_second_poll_budget() {
    let config = DebuggerConfig {
        session_ttl: Duration::from_millis(50),
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    let started = tokio::time::Instant::now();
    let batch = service.poll(poll(&instance)).await.unwrap();
    assert!(batch.active_sessions.is_empty());
    assert_eq!(started.elapsed(), Duration::from_millis(50));
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Expired
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_parallel_pollers_are_broadcast_woken_but_claim_only_once() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let (a, b, ()) = tokio::join!(biased; service.poll(poll(&instance)), service.poll(poll(&instance)), async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        service.enqueue(request(&session)).unwrap();
    });
    assert_eq!(a.unwrap().commands.len() + b.unwrap().commands.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn debugger_poll_waiter_capacity_is_finite_and_drop_releases_permit() {
    let service = DebuggerService::new();
    let instance = register(&service);
    open(&service, &instance);
    let mut waiters: Vec<_> = (0..4)
        .map(|_| Box::pin(service.poll(poll(&instance))))
        .collect();
    for waiter in &mut waiters {
        assert!(futures_util::poll!(waiter).is_pending());
    }
    assert_eq!(
        service.poll(poll(&instance)).await.unwrap_err().code,
        ErrorCode::Capacity
    );
    waiters.pop();
    let mut replacement = Box::pin(service.poll(poll(&instance)));
    assert!(futures_util::poll!(&mut replacement).is_pending());
    drop(replacement);
    drop(waiters);
}
