//! 暂停宿主时钟而保留真实 Node I/O，用文件门闩证明协议 2 不再截断为旧 60 秒。

use super::{
    liveness,
    support::{Fixture, OPERATION, context, pid},
};
use apk_domain::{Executor, Result};
use serde_json::Value;
use std::{
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

fn read_ready(fixture: &Fixture) -> Option<Value> {
    std::fs::read(fixture.marker.join("ready.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

async fn ready_without_timer<F>(mut call: Pin<&mut F>, fixture: &Fixture) -> Value
where
    F: Future<Output = Result<Value>>,
{
    let watchdog = Instant::now() + Duration::from_secs(12);
    loop {
        // 可运行的 yield 循环避免等待文件/管道时 Tokio 自动推进至内部期限。
        tokio::select! {
            biased;
            result = call.as_mut() => panic!("真实 Node 就绪前调用结束：{result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        if let Some(ready) = read_ready(fixture) {
            assert!(liveness::alive(pid(&ready)));
            return ready;
        }
        assert!(Instant::now() < watchdog, "真实 Node 未在观察上限内就绪");
    }
}

async fn pending_without_timer<F>(mut call: Pin<&mut F>)
where
    F: Future<Output = Result<Value>>,
{
    // 真实墙钟只限制观察循环，不用于业务 deadline 比较。
    let watchdog = Instant::now() + Duration::from_secs(1);
    while Instant::now() < watchdog {
        tokio::select! {
            biased;
            result = call.as_mut() => panic!("120 秒预算在推进 61 秒后提前结束：{result:?}"),
            _ = tokio::task::yield_now() => {}
        }
    }
}

async fn result_without_timer<F>(mut call: Pin<&mut F>) -> Result<Value>
where
    F: Future<Output = Result<Value>>,
{
    let watchdog = Instant::now() + Duration::from_secs(12);
    loop {
        tokio::select! {
            biased;
            result = call.as_mut() => return result,
            _ = tokio::task::yield_now() => {}
        }
        assert!(
            Instant::now() < watchdog,
            "释放文件后真实进程未完成响应和退出"
        );
    }
}

async fn real_process_for_device_api(api: u32) {
    let fixture = Fixture::with_device_api(2, api, false, false).await;
    assert_eq!(fixture.plugin.device_provider().unwrap().api_version, api);
    assert_eq!(
        fixture.plugin.device_provider().unwrap().capabilities[0].execution_timeout(),
        Duration::from_secs(120)
    );
    tokio::time::pause();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let call = fixture.plugin.execute_with_context(
        OPERATION,
        fixture.input("release"),
        CancellationToken::new(),
        context(deadline.into_std()),
    );
    tokio::pin!(call);
    let ready = ready_without_timer(call.as_mut(), &fixture).await;
    let before = tokio::time::Instant::now();
    tokio::time::advance(Duration::from_secs(61)).await;
    let after = tokio::time::Instant::now();
    assert_eq!(after.duration_since(before), Duration::from_secs(61));
    assert!(after < tokio::time::Instant::from_std(deadline.into_std()));
    pending_without_timer(call.as_mut()).await;
    assert_eq!(
        tokio::time::Instant::now(),
        after,
        "I/O 观察期间不得自动推进暂停时钟"
    );
    assert!(
        liveness::alive(pid(&ready)),
        "推进 61 秒后真实提供者仍在文件门闩处"
    );
    assert!(!fixture.marker.join("response_written.json").exists());
    std::fs::write(fixture.marker.join("release"), b"release").unwrap();
    let result = result_without_timer(call.as_mut()).await;
    tokio::time::resume();
    let value = result.expect("跨旧 60 秒后的真实协议 2 调用应成功");
    assert_eq!(value["result"]["copied"], true);
    assert_eq!(value["artifacts"][0]["sha256"], fixture.source.sha256);
    fixture.assert_cleaned(&ready).await;
    assert_eq!(fixture.event("process_exit").await["code"], 0);
    assert_eq!(fixture.store.committed(), 1);
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test]
async fn protocol_two_real_process_survives_sixty_one_seconds_of_host_time() {
    real_process_for_device_api(2).await;
}

#[tokio::test]
async fn api_three_protocol_two_real_process_survives_sixty_one_seconds_of_host_time() {
    real_process_for_device_api(3).await;
}
