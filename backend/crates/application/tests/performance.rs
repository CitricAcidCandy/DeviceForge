use apk_application::performance::PerformanceService;
use apk_domain::{Error, Executor, Result, performance::*};
use apk_infrastructure::performance::store::SqlitePerformance;
use async_trait::async_trait;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio_util::sync::CancellationToken;
struct Probe {
    calls: AtomicU64,
    fail: bool,
}
#[async_trait]
impl PerformanceProbe for Probe {
    async fn sample(
        &self,
        _: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance> {
        let count = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(Error::Dependency("模拟采样失败".into()));
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {},
        }
        Ok(RawPerformance {
            captured_at: apk_domain::now(),
            pid: 123,
            process_start_ticks: 900,
            process_ticks: 100 + count * 10,
            system_ticks: Some(1000 + count * 100),
            logical_cpus: Some(2),
            pss_kib: Some(1024),
            rss_kib: Some(2048),
            frame_window: None,
            device_observation: None,
            metric_missing: None,
        })
    }
}
fn request(duration_secs: u32) -> PerformanceStart {
    PerformanceStart {
        target: PerformanceTarget {
            device_id: "device".into(),
            package: "com.example.app".into(),
        },
        interval_ms: 1000,
        duration_secs,
    }
}
async fn wait(
    service: &PerformanceService,
    id: &str,
    condition: impl Fn(&PerformanceSession) -> bool,
) -> PerformanceSession {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let session = service.get(id.into()).await.unwrap();
            if condition(&session) {
                return session;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn sessions_pause_resume_finish_and_shutdown_without_late_samples() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(SqlitePerformance::open(directory.path().join("performance.db")).unwrap());
    let probe = Arc::new(Probe {
        calls: AtomicU64::new(0),
        fail: false,
    });
    let service = PerformanceService::new(probe.clone(), store, 1).unwrap();
    let session = service
        .start(request(10), CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        service.start(request(10), CancellationToken::new()).await,
        Err(Error::Conflict(_))
    ));
    wait(&service, &session.id, |session| session.samples >= 1).await;
    let paused = service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        service.get(session.id.clone()).await.unwrap().samples,
        paused.samples
    );
    service
        .change(session.id.clone(), PerformanceState::Running)
        .await
        .unwrap();
    wait(&service, &session.id, |session| {
        session.samples > paused.samples
    })
    .await;
    let page = service
        .samples(PerformanceSamples {
            session_id: session.id.clone(),
            after: paused.samples,
            limit: 100,
        })
        .await
        .unwrap();
    assert!(page.readings[0].cpu_share_percent.is_none());
    let stopped = service
        .change(session.id.clone(), PerformanceState::Stopped)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        service.get(session.id.clone()).await.unwrap().samples,
        stopped.samples
    );
    assert!(
        service
            .change(session.id.clone(), PerformanceState::Running)
            .await
            .is_err()
    );
    let completed = service
        .start(request(1), CancellationToken::new())
        .await
        .unwrap();
    wait(&service, &completed.id, |session| {
        session.state == PerformanceState::Completed
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let running = service
        .start(request(10), CancellationToken::new())
        .await
        .unwrap();
    service.shutdown().await.unwrap();
    assert_eq!(
        service.get(running.id).await.unwrap().state,
        PerformanceState::Interrupted
    );
    assert!(
        service
            .start(request(10), CancellationToken::new())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn failed_probe_releases_capacity_and_public_schema_rejects_invalid_targets() {
    let directory = tempfile::tempdir().unwrap();
    let service = PerformanceService::new(
        Arc::new(Probe {
            calls: AtomicU64::new(0),
            fail: true,
        }),
        Arc::new(SqlitePerformance::open(directory.path().join("performance.db")).unwrap()),
        1,
    )
    .unwrap();
    let operations = service.operations();
    assert_eq!(operations.len(), 8);
    let schema = &operations
        .iter()
        .find(|operation| operation.id == "android.performance.start")
        .unwrap()
        .input_schema;
    let validator = jsonschema::validator_for(schema).unwrap();
    assert!(validator.is_valid(&serde_json::to_value(request(10)).unwrap()));
    assert_eq!(schema["properties"]["interval_ms"]["minimum"], 50);
    for (interval_ms, accepted) in [
        (50, true),
        (49, false),
        (0, false),
        (60000, true),
        (60001, false),
    ] {
        let mut input = request(10);
        input.interval_ms = interval_ms;
        assert_eq!(
            validator.is_valid(&serde_json::to_value(&input).unwrap()),
            accepted,
            "公开模式的采样间隔：{interval_ms}"
        );
    }
    let mut invalid = request(10);
    invalid.target.package = "com.app;reboot".into();
    assert!(!validator.is_valid(&serde_json::to_value(&invalid).unwrap()));
    assert!(
        service
            .start(invalid, CancellationToken::new())
            .await
            .is_err()
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        service.start(request(10), cancel).await,
        Err(Error::Cancelled)
    ));
    for _ in 0..2 {
        let session = service
            .start(request(10), CancellationToken::new())
            .await
            .unwrap();
        let failed = wait(&service, &session.id, |session| {
            session.state == PerformanceState::Failed
        })
        .await;
        assert!(failed.error.unwrap().contains("模拟采样失败"));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let capabilities = service
        .execute(
            "android.performance.capabilities",
            serde_json::json!({}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(capabilities["fps"], false);
    service.shutdown().await.unwrap();
}

struct TimedProbe {
    probe: Probe,
    delay_ms: u64,
    active: AtomicU64,
    max_active: AtomicU64,
    timings: Mutex<Vec<(tokio::time::Instant, tokio::time::Instant)>>,
}
#[async_trait]
impl PerformanceProbe for TimedProbe {
    async fn sample(
        &self,
        target: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        let started = tokio::time::Instant::now();
        let result = async {
            tokio::select! {
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                _ = tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)) => {},
            }
            self.probe.sample(target, cancel).await
        }
        .await;
        let finished = tokio::time::Instant::now();
        self.timings.lock().unwrap().push((started, finished));
        self.active.fetch_sub(1, Ordering::SeqCst);
        result
    }
}

#[tokio::test]
async fn fifty_millisecond_sessions_schedule_fast_and_slow_probes_serially() {
    // 使用真实时钟、既有 worker 和 SQLite，分别覆盖小于与超过 50 毫秒的采样。
    for delay_ms in [0, 150] {
        let directory = tempfile::tempdir().unwrap();
        let probe = Arc::new(TimedProbe {
            probe: Probe {
                calls: AtomicU64::new(0),
                fail: false,
            },
            delay_ms,
            active: AtomicU64::new(0),
            max_active: AtomicU64::new(0),
            timings: Mutex::new(Vec::new()),
        });
        let service = PerformanceService::new(
            probe.clone(),
            Arc::new(SqlitePerformance::open(directory.path().join("performance.db")).unwrap()),
            2,
        )
        .unwrap();
        let mut input = request(1);
        input.interval_ms = 50;
        let session = service
            .start(input, CancellationToken::new())
            .await
            .unwrap();
        let completed = wait(&service, &session.id, |session| {
            session.state == PerformanceState::Completed
        })
        .await;
        service.shutdown().await.unwrap();

        assert_eq!(completed.request.interval_ms, 50);
        // 一秒内多次落库，既不能被钳回 1000 毫秒，也不能丢失周期等待。
        assert!(
            (3..=20).contains(&completed.samples),
            "额外采样耗时 {delay_ms} 毫秒，落库样本数 {}",
            completed.samples
        );
        assert_eq!(probe.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(probe.active.load(Ordering::SeqCst), 0);
        let timings = probe.timings.lock().unwrap();
        assert!(timings.len() >= 3);
        for pair in timings.windows(2) {
            assert!(pair[1].0 >= pair[0].1, "上一采样结束前启动了下一采样");
        }
    }
}

struct LateProbe {
    entered: tokio::sync::Notify,
    cleaned: tokio::sync::Notify,
}
#[async_trait]
impl PerformanceProbe for LateProbe {
    async fn sample(
        &self,
        _: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance> {
        self.entered.notify_one();
        cancel.cancelled().await;
        // 模拟端口清理阶段返回的成功数据，暂停以后仍不得落库。
        self.cleaned.notify_one();
        Ok(RawPerformance {
            captured_at: apk_domain::now(),
            pid: 123,
            process_start_ticks: 900,
            process_ticks: 10,
            system_ticks: Some(1000),
            logical_cpus: Some(2),
            pss_kib: Some(10),
            rss_kib: None,
            frame_window: None,
            device_observation: None,
            metric_missing: None,
        })
    }
}
struct PanicProbe;
#[async_trait]
impl PerformanceProbe for PanicProbe {
    async fn sample(&self, _: &PerformanceTarget, _: CancellationToken) -> Result<RawPerformance> {
        panic!("模拟第三方性能采样器异常")
    }
}
#[tokio::test]
async fn paused_inflight_sample_is_discarded_and_probe_panic_becomes_failed() {
    let directory = tempfile::tempdir().unwrap();
    let late = Arc::new(LateProbe {
        entered: tokio::sync::Notify::new(),
        cleaned: tokio::sync::Notify::new(),
    });
    let service = PerformanceService::new(
        late.clone(),
        Arc::new(SqlitePerformance::open(directory.path().join("late.db")).unwrap()),
        1,
    )
    .unwrap();
    let session = service
        .start(request(10), CancellationToken::new())
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), late.entered.notified())
        .await
        .unwrap();
    service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), late.cleaned.notified())
        .await
        .unwrap();
    assert_eq!(service.get(session.id.clone()).await.unwrap().samples, 0);
    assert_eq!(
        service
            .change(session.id.clone(), PerformanceState::Paused)
            .await
            .unwrap()
            .revision,
        1
    );
    service.shutdown().await.unwrap();
    assert_eq!(
        service.get(session.id).await.unwrap().state,
        PerformanceState::Interrupted
    );
    let service = PerformanceService::new(
        Arc::new(PanicProbe),
        Arc::new(SqlitePerformance::open(directory.path().join("panic.db")).unwrap()),
        1,
    )
    .unwrap();
    for _ in 0..2 {
        let session = service
            .start(request(10), CancellationToken::new())
            .await
            .unwrap();
        let failed = wait(&service, &session.id, |session| {
            session.state == PerformanceState::Failed
        })
        .await;
        assert!(failed.error.unwrap().contains("执行器异常"));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    service.shutdown().await.unwrap();
}
