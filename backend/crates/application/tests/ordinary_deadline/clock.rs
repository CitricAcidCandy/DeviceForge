//! 只推进宿主单调时钟；真实看门狗只避免门闩失联，并非性能证据。
use std::{future::Future, pin::Pin, task::Poll, time::Duration};
use tokio::time::Instant;

const WATCHDOG: Duration = Duration::from_secs(12);

pub async fn paused_until<T>(label: &str, mut observe: impl FnMut() -> Option<T>) -> T {
    let frozen = Instant::now();
    let wall_started = std::time::Instant::now();
    loop {
        assert_eq!(
            Instant::now(),
            frozen,
            "{label}：等待真实工作时不得自动推进宿主时钟"
        );
        if let Some(value) = observe() {
            return value;
        }
        assert!(wall_started.elapsed() < WATCHDOG, "{label}：门闩看门狗到期");
        tokio::task::yield_now().await;
    }
}

pub async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Option<F::Output> {
    std::future::poll_fn(move |context| {
        Poll::Ready(match future.as_mut().poll(context) {
            Poll::Ready(value) => Some(value),
            Poll::Pending => None,
        })
    })
    .await
}

pub async fn paused_future<F: Future>(label: &str, mut future: Pin<&mut F>) -> F::Output {
    let frozen = Instant::now();
    let wall_started = std::time::Instant::now();
    loop {
        assert_eq!(Instant::now(), frozen, "{label}：等待不得自动推进宿主时钟");
        if let Some(value) = poll_once(future.as_mut()).await {
            return value;
        }
        assert!(wall_started.elapsed() < WATCHDOG, "{label}：门闩看门狗到期");
        tokio::task::yield_now().await;
    }
}

pub async fn settle() {
    let frozen = Instant::now();
    for _ in 0..64 {
        tokio::task::yield_now().await;
        assert_eq!(Instant::now(), frozen, "让出调度不得自动推进宿主时钟");
    }
}

pub async fn expire_at(deadline: Instant) {
    let now = Instant::now();
    assert!(now <= deadline, "必须先在数学截止点内安排场景");
    tokio::time::advance(deadline.duration_since(now)).await;
    assert_eq!(Instant::now(), deadline, "原数学截止点不得被重计时");
    // Tokio 定时器以毫秒刻度唤醒；只推进观测刻度，不修改传入执行器的原截止点。
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(Instant::now(), deadline + Duration::from_millis(1));
}
