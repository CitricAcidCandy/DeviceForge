//! 调用配置读取有界等待，取消不得提前释放真实阻塞工作的执行名额。
use super::*;
use std::{sync::atomic::AtomicBool, sync::atomic::Ordering, time::Duration};
use tokio_util::sync::CancellationToken;

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("配置池测试等待超过独立上限")
}

struct Fixture {
    _temporary: tempfile::TempDir,
    store: Arc<FilePluginConfigurations>,
}
impl Fixture {
    async fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let deployment = temporary.path().join("plugins");
        fs::create_dir_all(deployment.join("demo")).unwrap();
        fs::write(
            deployment.join("demo/manifest.json"),
            serde_json::to_vec(&json!({
                "id":"demo","version":"1.0.0","protocol_version":1,
                "executable":"plugin.exe","args":[],"operations":[],
                "configuration": {
                    "version":1,"apply_policy":"next_invocation",
                    "schema":{"type":"object","properties":{"value":{"type":"integer"}}},
                    "defaults":{"value":1}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let store = FilePluginConfigurations::open(&temporary.path().join("managed"), &deployment)
            .await
            .unwrap();
        Self {
            _temporary: temporary,
            store,
        }
    }
}

#[tokio::test]
async fn incomplete_configuration_defaults_remain_editable_but_cannot_run_until_saved() {
    let fixture = Fixture::new().await;
    let manifest_path = fixture.store.deployment[0].join("demo/manifest.json");
    let mut manifest: Value = storage::json(&manifest_path).unwrap();
    manifest["configuration"] = json!({"version":1,"schema":{
        "type":"object","properties":{"endpoint":{"type":"string","minLength":1}},
        "required":["endpoint"],"additionalProperties":false},"defaults":{}});
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let draft = fixture.store.get("demo").await.unwrap();
    assert!(!draft.compatible);
    assert!(!draft.field_errors.is_empty());
    assert_eq!(draft.values, json!({}));
    assert_eq!(
        draft.definition.unwrap().apply_policy,
        ConfigurationApplyPolicy::NextInvocation
    );
    assert!(fixture.store.invocation_path("demo").await.is_err());
    let saved = fixture
        .store
        .patch("demo", draft.revision, json!({"endpoint":"configured"}))
        .await
        .unwrap();
    assert!(saved.compatible);
    assert!(
        fixture
            .store
            .invocation_path("demo")
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn invocation_configuration_and_resources_wait_for_busy_workers() {
    let fixture = Fixture::new().await;
    let occupied = fixture
        .store
        .workers
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let configuration = fixture.store.invocation_path("demo");
    let resources = fixture.store.resources_path("demo");
    tokio::pin!(configuration, resources);
    assert!(futures_util::poll!(&mut configuration).is_pending());
    assert!(futures_util::poll!(&mut resources).is_pending());
    assert_eq!(fixture.store.invocation_waiters.available_permits(), 6);
    drop(occupied);
    let (configuration, resources) =
        bounded(async { tokio::join!(configuration, resources) }).await;
    let configuration = configuration.unwrap().unwrap();
    let values: Value = serde_json::from_slice(&fs::read(configuration).unwrap()).unwrap();
    assert_eq!(values["value"], 1);
    assert!(resources.unwrap().is_none());
    assert_eq!(fixture.store.workers.available_permits(), 2);
    assert_eq!(fixture.store.invocation_waiters.available_permits(), 8);
}

#[tokio::test]
async fn invocation_waiters_are_bounded_and_ordinary_edits_keep_fail_fast_policy() {
    let fixture = Fixture::new().await;
    let occupied = fixture
        .store
        .workers
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let mut waiting = Vec::new();
    for _ in 0..8 {
        let mut future = Box::pin(fixture.store.invocation_work(|_| Ok(())));
        assert!(futures_util::poll!(&mut future).is_pending());
        waiting.push(future);
    }
    assert!(matches!(
        bounded(fixture.store.invocation_work(|_| Ok(()))).await,
        Err(Error::Conflict(message)) if message == "配置调用等待队列已满"
    ));
    assert!(matches!(
        bounded(fixture.store.work(|_| Ok(()))).await,
        Err(Error::Conflict(message)) if message == "配置工作池已满"
    ));
    drop(waiting.pop());
    assert_eq!(fixture.store.invocation_waiters.available_permits(), 1);
    let mut replacement = Box::pin(fixture.store.invocation_work(|_| Ok(())));
    assert!(futures_util::poll!(&mut replacement).is_pending());
    drop(replacement);
    drop(waiting);
    drop(occupied);
    assert_eq!(fixture.store.invocation_waiters.available_permits(), 8);
    assert_eq!(fixture.store.workers.available_permits(), 2);
}

#[tokio::test(start_paused = true)]
async fn invocation_waiting_uses_callers_cancellation_and_absolute_deadline() {
    let fixture = Fixture::new().await;
    let occupied = fixture
        .store
        .workers
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let executed = Arc::new(AtomicBool::new(false));
    for expired in [false, true] {
        let cancel = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let marker = executed.clone();
        let mut waiting = Box::pin(crate::execution_deadline::run(
            &cancel,
            Some(deadline),
            fixture.store.invocation_work(move |_| {
                marker.store(true, Ordering::Release);
                Ok(())
            }),
        ));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        if expired {
            tokio::time::advance(Duration::from_secs(1)).await;
            assert!(matches!(bounded(waiting).await, Err(Error::Timeout)));
        } else {
            cancel.cancel();
            assert!(matches!(bounded(waiting).await, Err(Error::Cancelled)));
        }
        assert_eq!(fixture.store.invocation_waiters.available_permits(), 8);
        assert_eq!(fixture.store.workers.available_permits(), 0);
        assert!(!executed.load(Ordering::Acquire));
    }
    drop(occupied);
    bounded(fixture.store.invocation_work(|_| Ok(())))
        .await
        .unwrap();
}

#[tokio::test]
async fn dropping_invocation_keeps_running_blocking_worker_occupied() {
    let fixture = Fixture::new().await;
    let occupied = fixture.store.workers.clone().acquire_owned().await.unwrap();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let store = fixture.store.clone();
    let invocation = tokio::spawn(async move {
        store
            .invocation_work(move |_| {
                entered.send(()).unwrap();
                resume.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    invocation.abort();
    assert!(bounded(invocation).await.unwrap_err().is_cancelled());
    assert_eq!(fixture.store.workers.available_permits(), 0);
    assert_eq!(fixture.store.invocation_waiters.available_permits(), 8);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.store.workers.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(occupied);
    assert_eq!(fixture.store.workers.available_permits(), 2);
}
