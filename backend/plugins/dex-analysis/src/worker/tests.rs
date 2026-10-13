use super::*;
use crate::tests::{fixture, protocol::Client, request};
use serde_json::json;
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn elapsed_ready_start_budget_does_not_start_worker() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let sample = fixture::sample(&[], &[]);
    let client = Client::start(
        request(&sample.bytes, "/unused".into(), "inspect"),
        1_000_000,
        Duration::from_millis(20),
        move |_, context| async move {
            run(context, move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                Ok(json!(null).into())
            })
            .await
        },
    )
    .await;
    let response = client.result().await;
    assert_eq!(response["cleanup"], "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("期限")
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn cancelling_started_worker_waits_for_physical_return_before_complete() {
    let (started, observed) = tokio::sync::oneshot::channel();
    let returned = Arc::new(AtomicBool::new(false));
    let physical = returned.clone();
    let sample = fixture::sample(&[], &[]);
    let mut client = Client::start(
        request(&sample.bytes, "/unused".into(), "inspect"),
        10_000_000_000,
        Duration::ZERO,
        move |_, context| async move {
            run(context, move |control| {
                started.send(()).unwrap();
                loop {
                    if let Err(error) = control.check() {
                        physical.store(true, Ordering::Release);
                        return Err(error.into());
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            })
            .await
        },
    )
    .await;
    observed.await.unwrap();
    client.send(json!({"protocol_version":4,"request_id":"dex-case","command":"cancel","reason":"cancelled"})).await;
    let response = client.result().await;
    assert_eq!(response["cleanup"], "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("取消")
    );
    assert!(returned.load(Ordering::Acquire));
}

#[tokio::test]
async fn dropping_worker_wait_keeps_permit_until_actual_blocking_closure_returns() {
    let sample = fixture::sample(&[], &[]);
    let client = Client::start(
        request(&sample.bytes, "/unused".into(), "inspect"),
        10_000_000_000,
        Duration::ZERO,
        move |_, context| async move {
            let (started, observed) = tokio::sync::oneshot::channel();
            let (release, hold) = std::sync::mpsc::channel();
            let mut work = Box::pin(execute(context, move |_| {
                started.send(()).unwrap();
                hold.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(json!(null).into())
            }));
            tokio::select! {
                result = &mut work => panic!("工作尚未释放就返回：{}", result.is_ok()),
                observed = observed => observed.unwrap(),
            }
            drop(work);
            assert!(SLOTS.try_acquire().is_err());
            release.send(()).unwrap();
            let permit = tokio::time::timeout(Duration::from_secs(2), SLOTS.acquire())
                .await
                .unwrap()
                .unwrap();
            drop(permit);
            Execution::complete(Ok(json!({"physical_return":true}).into()))
        },
    )
    .await;
    assert_eq!(
        client.result().await["response"]["result"]["physical_return"],
        true
    );
}

#[test]
fn dropped_wait_retains_unresolved_marker() {
    let unresolved = Arc::new(AtomicBool::new(false));
    let stop = CancellationToken::new();
    drop(Waiting {
        stop: stop.clone(),
        unresolved: unresolved.clone(),
        armed: true,
    });
    assert!(stop.is_cancelled());
    assert!(unresolved.load(Ordering::Acquire));
}
