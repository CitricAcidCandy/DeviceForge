use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{Error, Executor, Operation, Result, plugin_recovery::*, plugins::*};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct Recoverable(AtomicBool);
#[async_trait]
impl Executor for Recoverable {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.recovery-test.echo".into(),
            title: "回显".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    fn has_unresolved_resources(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn recovery_timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(2))
    }
    async fn recover_resources(
        &self,
        _: Value,
        _: CancellationToken,
        _: apk_domain::ExecutionContext,
    ) -> Result<RecoveryReport> {
        self.0.store(false, Ordering::Release);
        Ok(RecoveryReport {
            coverage: "plugin".into(),
            inspected: 1,
            remaining: 0,
            status: RecoveryStatus::Recovered,
            message: "资源已核对".into(),
            checks: vec![RecoveryCheck {
                resource: "测试资源".into(),
                status: CheckStatus::Confirmed,
                message: "已退出".into(),
            }],
        })
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        Ok(input)
    }
}
struct Catalog;
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, _: &str) -> Result<PluginContribution> {
        Err(Error::NotFound("测试未部署".into()))
    }
}

#[tokio::test]
async fn recovery_http_has_v2_logs_generation_guard_and_real_application_result() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    let service = PluginService::new(app.clone(), Arc::new(Catalog), Default::default());
    let loaded = service
        .seed(PluginContribution {
            id: "recovery-test".into(),
            version: "1".into(),
            executor: Arc::new(Recoverable(AtomicBool::new(true))),
        })
        .await
        .unwrap();
    let router = apk_server::router(app.clone(), String::new(), 1000).unwrap();
    let path = "/api/v2/plugins/recovery-test/recovery";
    let response = router
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let initial: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert!(initial["log_id"].is_string());
    assert_eq!(initial["data"]["cleanup_failed"], true);
    for (generation, expected) in [
        ("old", StatusCode::CONFLICT),
        (loaded.generation.as_str(), StatusCode::OK),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"generation":generation,"input":{}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert!(value["log_id"].is_string());
        if expected == StatusCode::OK {
            assert_eq!(value["data"]["cleanup_failed"], false);
            assert_eq!(value["data"]["last_report"]["status"], "recovered");
        }
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn recovery_endpoint_keeps_existing_optional_authentication() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    let router = apk_server::router(app, "local-test-token".into(), 1000).unwrap();
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/v2/plugins/example/recovery")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
