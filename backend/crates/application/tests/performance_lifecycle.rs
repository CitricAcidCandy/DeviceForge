#[path = "performance_lifecycle/blocking_store.rs"]
mod blocking_store;
#[path = "performance_lifecycle/fixture.rs"]
mod fixture;

use apk_domain::{Error, Executor, JobStatus, performance::*, plugins::PluginState};
use apk_infrastructure::performance::store::SqlitePerformance;
use blocking_store::{BlockingStore, TERMINAL_ERROR};
use fixture::{
    Fixture, SOURCE_ID, notified, request, wait_plugin, wait_session, wait_shutdown_started,
};
use serde_json::json;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn registered_source_reload_interrupts_running_and_paused_without_rewriting_history() {
    let fixture = Fixture::new(Arc::new(SqlitePerformance::open(":memory:").unwrap()), 1);
    assert!(matches!(
        fixture
            .service
            .execute(
                "android.performance.capabilities",
                json!({}),
                CancellationToken::new(),
            )
            .await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        fixture
            .service
            .start(request(30), CancellationToken::new())
            .await,
        Err(Error::NotFound(_))
    ));
    let first_generation = fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let capabilities = fixture
        .service
        .execute(
            "android.performance.capabilities",
            json!({}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(capabilities["source"], "plugin.source");
    let running = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await
        .unwrap();
    let first = wait_session(&fixture.service, &running.id, |session| {
        session.samples >= 1
    })
    .await;
    fixture.source.mode.store(1, Ordering::Release);
    notified(&fixture.source.entered).await;
    let unloaded = fixture.plugins.unload(SOURCE_ID.into()).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(!unloaded.cleanup_failed);
    notified(&fixture.source.cleaned).await;
    let old = fixture.service.get(running.id.clone()).await.unwrap();
    assert_eq!(old.state, PerformanceState::Interrupted);
    assert_eq!(old.samples, first.samples);
    assert_eq!(old.source, running.source);

    let second_generation = fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    assert_ne!(first_generation.generation, second_generation.generation);
    assert!(matches!(
        fixture
            .service
            .change(running.id.clone(), PerformanceState::Running)
            .await,
        Err(Error::Conflict(_))
    ));
    let paused = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await
        .unwrap();
    notified(&fixture.source.entered).await;
    fixture
        .service
        .change(paused.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    notified(&fixture.source.cleaned).await;
    fixture.plugins.unload(SOURCE_ID.into()).await.unwrap();
    let interrupted = fixture.service.get(paused.id.clone()).await.unwrap();
    assert_eq!(interrupted.state, PerformanceState::Interrupted);
    assert_eq!(interrupted.samples, 0);
    assert_eq!(interrupted.source, paused.source);
    assert_eq!(
        old.source.as_ref().unwrap().generation,
        first_generation.generation
    );
    assert_eq!(
        interrupted.source.as_ref().unwrap().generation,
        second_generation.generation
    );
    let page = fixture
        .service
        .samples(PerformanceSamples {
            session_id: running.id.clone(),
            after: 0,
            limit: 100,
        })
        .await
        .unwrap();
    assert_eq!(page.session.source, running.source);
    assert_eq!(page.readings.len() as u64, first.samples);
    let history = fixture
        .service
        .list(PerformanceList {
            after_id: None,
            limit: 100,
        })
        .await
        .unwrap();
    assert_eq!(history.sessions.len(), 2);
    for expected in [&running, &paused] {
        assert_eq!(
            history
                .sessions
                .iter()
                .find(|session| session.id == expected.id)
                .unwrap()
                .source,
            expected.source
        );
    }
    assert!(fixture.app.list(10).unwrap().is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn cancelling_the_real_start_job_keeps_the_accepted_session_alive() {
    let fixture = Fixture::new(Arc::new(SqlitePerformance::open(":memory:").unwrap()), 1);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    fixture.host.hold_start.store(true, Ordering::Release);
    let job = fixture
        .app
        .submit(
            "android.performance.start",
            serde_json::to_value(request(30)).unwrap(),
        )
        .unwrap();
    notified(&fixture.host.accepted).await;
    let session = fixture.host.session.lock().unwrap().clone().unwrap();
    let first = wait_session(&fixture.service, &session.id, |current| {
        current.samples >= 1
    })
    .await;
    assert_eq!(
        fixture.app.cancel(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    let later = wait_session(&fixture.service, &session.id, |current| {
        current.samples > first.samples
    })
    .await;
    assert_eq!(later.state, PerformanceState::Running);
    assert_eq!(later.source, session.source);
    assert_eq!(
        fixture.app.get(&job.id).unwrap().status,
        JobStatus::Cancelled
    );
    assert_eq!(fixture.app.list(10).unwrap().len(), 1);
    fixture
        .service
        .change(session.id, PerformanceState::Stopped)
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timed_out_create_keeps_capacity_and_real_work_in_owner_and_service_drain() {
    let store = BlockingStore::new(true);
    let _release = store.gate.release_on_drop();
    let fixture = Fixture::new(store.clone(), 1);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let service = fixture.service.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    let start = tokio::spawn(async move {
        service
            .start_with_context(request(30), CancellationToken::new(), Some(deadline))
            .await
    });
    notified(&store.gate.entered).await;
    let pending = store.created.lock().unwrap().clone().unwrap();
    let capacity = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await;
    assert!(matches!(capacity, Err(Error::Conflict(message)) if message.contains("并发")));
    let plugins = fixture.plugins.clone();
    let mut unload = tokio::spawn(async move { plugins.unload(SOURCE_ID.into()).await });
    wait_plugin(&fixture.plugins, |plugin| {
        plugin.state == PluginState::Draining
    })
    .await;
    let service = fixture.service.clone();
    let mut shutdown = tokio::spawn(async move { service.shutdown().await });
    wait_shutdown_started(&fixture.service).await;
    assert!(matches!(start.await.unwrap(), Err(Error::Timeout)));
    assert!(tokio::time::Instant::now() >= deadline);
    // 外层已经超时，实际闭包仍持有两个排空凭据，不能提前确认卸载或关闭。
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut unload)
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    assert_eq!(fixture.source.calls.load(Ordering::Acquire), 0);
    store.gate.release();
    let unloaded = tokio::time::timeout(Duration::from_secs(3), unload)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(!unloaded.cleanup_failed);
    tokio::time::timeout(Duration::from_secs(3), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let finished = store.inner.get(&pending.id).unwrap();
    assert_eq!(finished.state, PerformanceState::Interrupted);
    assert_eq!(finished.source, pending.source);
    assert_eq!(finished.samples, 0);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_commit_rechecks_the_original_sample_deadline_and_never_appends_late_raw() {
    let store = BlockingStore::new(false);
    let _release = store.gate.release_on_drop();
    let fixture = Fixture::new(store.clone(), 1);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    *fixture.source.block_commit_get.lock().unwrap() = Some(store.next_get.clone());
    let session = fixture
        .service
        .start(request(1), CancellationToken::new())
        .await
        .unwrap();
    notified(&store.gate.entered).await;
    let original_deadline = fixture.source.deadlines.lock().unwrap()[0].unwrap();
    tokio::time::sleep_until(
        tokio::time::Instant::from_std(original_deadline) + Duration::from_millis(1),
    )
    .await;
    assert_eq!(
        store.inner.get(&session.id).unwrap().state,
        PerformanceState::Running
    );
    assert_eq!(store.append_calls.load(Ordering::Acquire), 0);
    assert_eq!(fixture.source.calls.load(Ordering::Acquire), 1);
    let capacity = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await;
    assert!(matches!(capacity, Err(Error::Conflict(message)) if message.contains("并发")));
    let service = fixture.service.clone();
    let mut shutdown = tokio::spawn(async move { service.shutdown().await });
    wait_shutdown_started(&fixture.service).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    store.gate.release();
    tokio::time::timeout(Duration::from_secs(3), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let finished = store.inner.get(&session.id).unwrap();
    assert_eq!(finished.state, PerformanceState::Completed);
    assert_eq!(finished.samples, 0);
    assert_eq!(finished.source, session.source);
    assert_eq!(store.append_calls.load(Ordering::Acquire), 0);
    assert!(!fixture.plugins.list()[0].cleanup_failed);
    fixture.close().await;
}

#[tokio::test]
async fn historical_cleanup_warning_allows_pause_resume_stop_and_reload() {
    let fixture = Fixture::new(Arc::new(SqlitePerformance::open(":memory:").unwrap()), 1);
    fixture.source.mode.store(2, Ordering::Release);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let session = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await
        .unwrap();
    notified(&fixture.source.entered).await;
    fixture.source.unresolved.store(true, Ordering::Release);
    let paused = fixture
        .service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    assert_eq!(paused.state, PerformanceState::Paused);
    assert!(paused.error.is_none());
    notified(&fixture.source.cleaned).await;
    fixture.source.unresolved.store(false, Ordering::Release);
    // 来源外部标志复位以后，已登记的宿主清理风险仍然保持。
    wait_plugin(&fixture.plugins, |plugin| plugin.cleanup_failed).await;
    let same = fixture
        .service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    assert_eq!(same.revision, paused.revision);
    assert_eq!(same.error, paused.error);
    fixture.source.mode.store(0, Ordering::Release);
    let resumed = fixture
        .service
        .change(session.id.clone(), PerformanceState::Running)
        .await
        .unwrap();
    assert_eq!(resumed.state, PerformanceState::Running);
    let stopped = fixture
        .service
        .change(session.id.clone(), PerformanceState::Stopped)
        .await
        .unwrap();
    assert_eq!(stopped.state, PerformanceState::Stopped);
    assert_eq!(stopped.source, session.source);
    assert_eq!(
        fixture
            .service
            .change(session.id.clone(), PerformanceState::Stopped)
            .await
            .unwrap()
            .revision,
        stopped.revision
    );
    fixture.service.shutdown().await.unwrap();
    let history = fixture.service.get(session.id).await.unwrap();
    assert_eq!(history.state, PerformanceState::Stopped);
    assert_eq!(history.samples, stopped.samples);
    assert!(fixture.plugins.list()[0].cleanup_failed);
    assert!(
        fixture
            .plugins
            .unload(SOURCE_ID.into())
            .await
            .unwrap()
            .cleanup_failed
    );
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_pending_start_cancels_assembly_without_cancelling_the_caller_token() {
    let store = BlockingStore::new(true);
    let _release = store.gate.release_on_drop();
    let fixture = Fixture::new(store.clone(), 1);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let caller = CancellationToken::new();
    let child = caller.clone();
    let service = fixture.service.clone();
    let start = tokio::spawn(async move { service.start(request(30), child).await });
    notified(&store.gate.entered).await;
    let pending = store.created.lock().unwrap().clone().unwrap();
    start.abort();
    assert!(start.await.unwrap_err().is_cancelled());
    assert!(!caller.is_cancelled());
    store.gate.release();
    let stopped = wait_session(&fixture.service, &pending.id, |session| {
        session.state.terminal()
    })
    .await;
    assert_eq!(stopped.state, PerformanceState::Stopped);
    assert_eq!(stopped.samples, 0);
    assert_eq!(stopped.source, pending.source);
    assert_eq!(fixture.source.calls.load(Ordering::Acquire), 0);
    fixture.close().await;
    assert!(!caller.is_cancelled());
    assert_eq!(fixture.source.calls.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn shutdown_reports_the_first_terminal_storage_failure_and_retries_on_the_next_call() {
    let store = BlockingStore::new(false);
    let fixture = Fixture::new(store.clone(), 1);
    fixture.source.mode.store(1, Ordering::Release);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let session = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await
        .unwrap();
    notified(&fixture.source.entered).await;
    let paused = fixture
        .service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    notified(&fixture.source.cleaned).await;
    store.terminal_failures.store(1, Ordering::Release);
    assert!(
        matches!(fixture.service.shutdown().await, Err(Error::Storage(message)) if message == TERMINAL_ERROR)
    );
    let pending = fixture.service.get(session.id.clone()).await.unwrap();
    assert_eq!(pending.state, PerformanceState::Paused);
    assert_eq!(pending.revision, paused.revision);
    assert_eq!(store.terminal_attempts.load(Ordering::Acquire), 1);
    assert!(!fixture.plugins.list()[0].cleanup_failed);
    fixture.service.shutdown().await.unwrap();
    let history = fixture.service.get(session.id).await.unwrap();
    assert_eq!(history.state, PerformanceState::Interrupted);
    assert_eq!(history.samples, paused.samples);
    assert_eq!(history.source, session.source);
    assert_eq!(store.terminal_attempts.load(Ordering::Acquire), 2);
    fixture.close().await;
}

#[tokio::test]
async fn ordinary_terminal_storage_failure_does_not_turn_owner_unload_into_cleanup_failure() {
    let store = BlockingStore::new(false);
    let fixture = Fixture::new(store.clone(), 1);
    fixture.source.mode.store(1, Ordering::Release);
    fixture.plugins.load(SOURCE_ID.into()).await.unwrap();
    let session = fixture
        .service
        .start(request(30), CancellationToken::new())
        .await
        .unwrap();
    notified(&fixture.source.entered).await;
    let paused = fixture
        .service
        .change(session.id.clone(), PerformanceState::Paused)
        .await
        .unwrap();
    notified(&fixture.source.cleaned).await;
    store.terminal_failures.store(1, Ordering::Release);
    let unloaded = fixture.plugins.unload(SOURCE_ID.into()).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(!unloaded.cleanup_failed);
    let pending = fixture.service.get(session.id.clone()).await.unwrap();
    assert_eq!(pending.state, PerformanceState::Paused);
    assert_eq!(pending.revision, paused.revision);
    assert_eq!(pending.source, session.source);
    assert_eq!(store.terminal_attempts.load(Ordering::Acquire), 1);
    assert!(matches!(
        fixture
            .service
            .change(session.id.clone(), PerformanceState::Running)
            .await,
        Err(Error::Conflict(_))
    ));
    // 卸载期间已留下待重试登记，下次关闭在入口即可重试该历史收口。
    fixture.service.shutdown().await.unwrap();
    let history = fixture.service.get(session.id).await.unwrap();
    assert_eq!(history.state, PerformanceState::Interrupted);
    assert_eq!(history.samples, paused.samples);
    assert_eq!(history.source, session.source);
    assert_eq!(store.terminal_attempts.load(Ordering::Acquire), 2);
    fixture.close().await;
}
