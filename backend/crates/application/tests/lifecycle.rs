use apk_application::Application;
use apk_domain::{Error, Executor, JobStatus, Operation};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct Controlled {
    started: Arc<Notify>,
    release: Arc<Notify>,
    calls: AtomicUsize,
}
#[async_trait]
impl Executor for Controlled {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "test.echo".into(),
            title: "测试操作".into(),
            input_schema: json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}),
        }]
    }
    async fn execute(
        &self,
        _: &str,
        input: Value,
        _: CancellationToken,
    ) -> apk_domain::Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        self.release.notified().await;
        if input["value"] == -1 {
            Err(Error::Dependency("测试失败".into()))
        } else {
            Ok(input)
        }
    }
}
fn setup(capacity: usize) -> (Arc<Application>, Arc<Controlled>) {
    let executor = Arc::new(Controlled {
        started: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
        calls: AtomicUsize::new(0),
    });
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![executor.clone()],
        1,
        capacity,
    )
    .unwrap();
    (app, executor)
}
async fn terminal(app: &Application, id: &str) -> apk_domain::Job {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let job = app.get(id).unwrap();
            if job.status.is_terminal() {
                break job;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn schema_conflicts_and_unknown_operations() {
    let (app, executor) = setup(4);
    assert!(matches!(
        app.submit("absent", json!({})),
        Err(Error::NotFound(_))
    ));
    for input in [
        json!({}),
        json!({"value":"x"}),
        json!({"value":1,"extra":true}),
    ] {
        assert!(matches!(
            app.submit("test.echo", input),
            Err(Error::Invalid(_))
        ));
    }
    assert!(app.list(10).unwrap().is_empty());
    assert!(matches!(
        Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![executor.clone(), executor],
            1,
            4
        ),
        Err(Error::Conflict(_))
    ));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancellation_queue_limit_and_single_worker() {
    let (app, executor) = setup(2);
    let first = app.submit("test.echo", json!({"value":1})).unwrap();
    executor.started.notified().await;
    let queued = app.submit("test.echo", json!({"value":2})).unwrap();
    assert_eq!(app.get(&queued.id).unwrap().status, JobStatus::Queued);
    assert!(matches!(
        app.submit("test.echo", json!({"value":3})),
        Err(Error::Conflict(_))
    ));
    assert_eq!(app.cancel(&queued.id).unwrap().status, JobStatus::Cancelled);
    assert_eq!(app.cancel(&first.id).unwrap().status, JobStatus::Cancelled);
    executor.release.notify_one();
    app.shutdown().await.unwrap();
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert_eq!(app.get(&first.id).unwrap().status, JobStatus::Cancelled);
    assert_eq!(app.get(&queued.id).unwrap().status, JobStatus::Cancelled);
    assert!(matches!(
        app.submit("test.echo", json!({"value":4})),
        Err(Error::Conflict(_))
    ));
}
#[tokio::test]
async fn success_failure_and_event_cursor() {
    let (app, executor) = setup(4);
    let success = app.submit("test.echo", json!({"value":7})).unwrap();
    executor.started.notified().await;
    executor.release.notify_one();
    assert_eq!(
        terminal(&app, &success.id).await.result,
        Some(json!({"value":7}))
    );
    let events = app.events(&success.id, 0).unwrap();
    assert_eq!(
        events.iter().map(|e| e.status.clone()).collect::<Vec<_>>(),
        vec![JobStatus::Queued, JobStatus::Running, JobStatus::Succeeded]
    );
    assert!(
        app.events(&success.id, events[2].sequence)
            .unwrap()
            .is_empty()
    );
    let failure = app.submit("test.echo", json!({"value":-1})).unwrap();
    executor.started.notified().await;
    executor.release.notify_one();
    let failed = terminal(&app, &failure.id).await;
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(failed.error.unwrap().contains("测试失败"));
    app.shutdown().await.unwrap();
}

struct PanicExecutor;
#[async_trait]
impl Executor for PanicExecutor {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "test.panic".into(),
            title: "异常执行器".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> apk_domain::Result<Value> {
        panic!("测试执行器异常");
    }
}
#[tokio::test]
async fn executor_panic_becomes_failure_and_releases_capacity() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(PanicExecutor)],
        1,
        1,
    )
    .unwrap();
    let job = app.submit("test.panic", json!({})).unwrap();
    assert_eq!(terminal(&app, &job.id).await.status, JobStatus::Failed);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match app.submit("test.panic", json!({})) {
                Ok(next) => {
                    assert_eq!(terminal(&app, &next.id).await.status, JobStatus::Failed);
                    break;
                }
                Err(Error::Conflict(_)) => tokio::task::yield_now().await,
                Err(error) => panic!("意外错误：{error}"),
            }
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
}
