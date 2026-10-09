use apk_application::Application;
use apk_domain::{Job, JobEvent, JobStatus, JobStore, Result};
use apk_infrastructure::store::SqliteStore;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tower::ServiceExt;

struct SlowStore {
    inner: SqliteStore,
    entered: tokio::sync::Notify,
    release: Mutex<mpsc::Receiver<()>>,
}
impl JobStore for SlowStore {
    fn create(&self, job: &Job) -> Result<()> {
        self.inner.create(job)
    }
    fn get(&self, id: &str) -> Result<Job> {
        self.inner.get(id)
    }
    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.entered.notify_one();
        let _ = self
            .release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(3));
        self.inner.list(limit)
    }
    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        output: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        self.inner.transition(id, status, output, error)
    }
    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        self.inner.events(id, after)
    }
    fn recover(&self) -> Result<()> {
        self.inner.recover()
    }
}
async fn request(router: axum::Router, path: &str) -> Response {
    router
        .oneshot(
            Request::builder()
                .uri(path)
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn slow_database_keeps_single_thread_health_responsive() {
    let (release, receiver) = mpsc::channel();
    let store = Arc::new(SlowStore {
        inner: SqliteStore::open(":memory:").unwrap(),
        entered: tokio::sync::Notify::new(),
        release: Mutex::new(receiver),
    });
    let app = Application::new(store.clone(), vec![], 1, 8).unwrap();
    let router = apk_server::router(app.clone(), "test-token".into(), 100).unwrap();
    let list = tokio::spawn(request(router.clone(), "/api/v2/jobs"));
    tokio::time::timeout(Duration::from_secs(2), store.entered.notified())
        .await
        .unwrap();
    let started = Instant::now();
    let health = tokio::time::timeout(
        Duration::from_millis(500),
        request(router, "/api/v2/health"),
    )
    .await
    .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(!list.is_finished());
    release.send(()).unwrap();
    assert_eq!(list.await.unwrap().status(), StatusCode::OK);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn unconsumed_responses_are_bounded_and_disconnect_releases_slot() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), "test-token".into(), 10000).unwrap();
    let mut held = Vec::new();
    for _ in 0..128 {
        let response = request(router.clone(), "/api/v2/health").await;
        assert_eq!(response.status(), StatusCode::OK);
        held.push(response);
    }
    let rejected = request(router.clone(), "/api/v2/health").await;
    assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
    let body: Value =
        serde_json::from_slice(&to_bytes(rejected.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "concurrency_limited");
    drop(held.pop());
    assert_eq!(
        request(router, "/api/v2/health").await.status(),
        StatusCode::OK
    );
    drop(held);
    app.shutdown().await.unwrap();
}
