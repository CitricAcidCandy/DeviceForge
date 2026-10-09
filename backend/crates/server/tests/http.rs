use apk_application::Application;
use apk_domain::{Executor, Operation};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
struct Echo;
#[async_trait]
impl Executor for Echo {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.test.echo".into(),
            title: "回显".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    async fn execute(
        &self,
        _: &str,
        input: Value,
        _: CancellationToken,
    ) -> apk_domain::Result<Value> {
        Ok(input)
    }
}
fn setup(limit: u32) -> (Arc<Application>, Router) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), "test-only-token".into(), limit).unwrap();
    (app, router)
}
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: String,
    authorized: bool,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if authorized {
        builder = builder.header("authorization", "Bearer test-only-token");
    }
    let response = router
        .clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn authentication_errors_and_request_limits() {
    let (app, router) = setup(100);
    for path in [
        "/api/v1/health",
        "/api/v1/operations",
        "/api/v1/openapi.json",
        "/unknown",
    ] {
        let (status, value) = request(&router, "GET", path, String::new(), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(value["code"], "unauthorized");
    }
    for (path, status) in [
        ("/api/v1/jobs?limit=0", StatusCode::BAD_REQUEST),
        ("/api/v1/jobs?limit=201", StatusCode::BAD_REQUEST),
        ("/api/v1/jobs/missing", StatusCode::NOT_FOUND),
        ("/unknown", StatusCode::NOT_FOUND),
    ] {
        assert_eq!(
            request(&router, "GET", path, String::new(), true).await.0,
            status
        );
    }
    assert_eq!(
        request(&router, "DELETE", "/api/v1/jobs", String::new(), true)
            .await
            .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    for body in [
        "{".to_owned(),
        json!({"operation":"plugin.test.echo","input":{},"extra":true}).to_string(),
    ] {
        assert_eq!(
            request(&router, "POST", "/api/v1/jobs", body, true).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, body) = request(
        &router,
        "POST",
        "/api/v1/jobs",
        "x".repeat(256 * 1024 + 1),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "invalid_input");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn optional_token_allows_http_without_credentials_and_keeps_request_guards() {
    let (app, _) = setup(100);
    let router = apk_server::router(app.clone(), String::new(), 100).unwrap();
    for path in [
        "/api/v1/health",
        "/api/v1/operations",
        "/api/v1/openapi.json",
    ] {
        assert_eq!(
            request(&router, "GET", path, String::new(), false).await.0,
            StatusCode::OK
        );
    }
    let (status, response) = request(
        &router,
        "POST",
        "/api/v2/jobs",
        json!({"operation":"plugin.test.echo","input":{"value":8}}).to_string(),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(response["log_id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(response["data"]["operation"], "plugin.test.echo");
    let limited = apk_server::router(app.clone(), String::new(), 1).unwrap();
    assert_eq!(
        request(&limited, "GET", "/api/v1/health", String::new(), false)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&limited, "GET", "/api/v1/health", String::new(), false)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    for invalid in [" ", "has whitespace"] {
        assert!(apk_server::router(app.clone(), invalid.into(), 100).is_err());
    }
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn contributions_jobs_events_and_generated_schema() {
    let (app, router) = setup(100);
    let (_, operations) = request(&router, "GET", "/api/v1/operations", String::new(), true).await;
    assert_eq!(operations[0]["id"], "plugin.test.echo");
    let (status, queued) = request(
        &router,
        "POST",
        "/api/v1/jobs",
        json!({"operation":"plugin.test.echo","input":{"value":8}}).to_string(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let id = queued["id"].as_str().unwrap();
    let (status, job) = request(
        &router,
        "GET",
        &format!("/api/v1/jobs/{id}"),
        String::new(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["operation"], "plugin.test.echo");
    let (status, events) = request(
        &router,
        "GET",
        &format!("/api/v1/jobs/{id}/events?after=0"),
        String::new(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!events.as_array().unwrap().is_empty());
    let (status, schema) =
        request(&router, "GET", "/api/v1/openapi.json", String::new(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(schema["openapi"], "3.1.0");
    assert!(schema["paths"]["/api/v1/jobs"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"].get("operation").is_some());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn authenticated_rate_limit() {
    let (app, router) = setup(1);
    assert_eq!(
        request(&router, "GET", "/api/v1/health", String::new(), false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&router, "GET", "/api/v1/health", String::new(), true)
            .await
            .0,
        StatusCode::OK
    );
    let (status, body) = request(&router, "GET", "/api/v1/health", String::new(), true).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "rate_limited");
    app.shutdown().await.unwrap();
}
