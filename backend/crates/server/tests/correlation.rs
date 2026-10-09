use apk_application::Application;
use apk_domain::{Executor, Operation};
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use deviceforge_observability::LogContext;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct Echo(Arc<Mutex<Vec<String>>>);
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
        self.0
            .lock()
            .unwrap()
            .push(LogContext::current().unwrap().log_id);
        Ok(input)
    }
}
type Observations = Arc<Mutex<Vec<String>>>;
async fn setup(limit: u32) -> (Arc<Application>, Router, Observations, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let observations = Arc::new(Mutex::new(Vec::new()));
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo(observations.clone()))],
        2,
        8,
    )
    .unwrap();
    let artifacts = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    let router = apk_server::router_with_artifacts(
        app.clone(),
        "test-token".into(),
        limit,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    (app, router, observations, directory)
}
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: impl Into<Body>,
    authorized: bool,
    content_type: &str,
) -> (StatusCode, String, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type)
        .header("accept", "application/json, text/event-stream")
        .header("host", "localhost")
        .header("x-deviceforge-log-id", "客户端伪造的ID");
    if authorized {
        builder = builder.header("authorization", "Bearer test-token");
    }
    let response = router
        .clone()
        .oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let log_id = response.headers()["x-deviceforge-log-id"]
        .to_str()
        .unwrap()
        .to_owned();
    uuid::Uuid::parse_str(&log_id).unwrap();
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, log_id, bytes)
}
fn value(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn v2_lists_errors_health_and_v1_compatibility() {
    let (app, router, _, _directory) = setup(100).await;
    for (path, key) in [
        ("/api/v2/operations", "data"),
        ("/api/v2/jobs", "data"),
        ("/api/v2/missing", "error"),
    ] {
        let (_, id, bytes) = request(&router, "GET", path, "", true, "application/json").await;
        let body = value(&bytes);
        assert_eq!(body["log_id"], id);
        if key == "data" {
            assert!(body[key].is_array());
        } else {
            assert_eq!(body[key]["code"], "not_found");
        }
    }
    let (_, id, bytes) = request(
        &router,
        "GET",
        "/api/v2/health",
        "",
        true,
        "application/json",
    )
    .await;
    assert_eq!(
        value(&bytes),
        json!({"log_id":id,"data":{"status":"ok","api_version":2}})
    );
    let (_, _, bytes) = request(
        &router,
        "GET",
        "/api/v1/operations",
        "",
        true,
        "application/json",
    )
    .await;
    assert!(value(&bytes).is_array());
    for (method, path, input, authorized, status) in [
        ("GET", "/api/v2/health", "", false, StatusCode::UNAUTHORIZED),
        ("POST", "/api/v2/jobs", "{", true, StatusCode::BAD_REQUEST),
        (
            "GET",
            "/api/v2/jobs?limit=0",
            "",
            true,
            StatusCode::BAD_REQUEST,
        ),
        (
            "DELETE",
            "/api/v2/jobs",
            "",
            true,
            StatusCode::METHOD_NOT_ALLOWED,
        ),
    ] {
        let (actual, id, bytes) =
            request(&router, method, path, input, authorized, "application/json").await;
        assert_eq!(actual, status);
        assert_eq!(value(&bytes)["log_id"], id);
        assert!(value(&bytes)["error"]["code"].is_string());
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn rate_limit_and_background_job_keep_correlation() {
    let (app, router, observations, _directory) = setup(100).await;
    let (_, origin, bytes) = request(
        &router,
        "POST",
        "/api/v2/jobs",
        json!({"operation":"plugin.test.echo","input":{}}).to_string(),
        true,
        "application/json",
    )
    .await;
    let job = value(&bytes)["data"]["id"].as_str().unwrap().to_owned();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !app.get(&job).unwrap().status.is_terminal() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*observations.lock().unwrap(), vec![origin]);
    app.shutdown().await.unwrap();
    let (app, router, _, _directory) = setup(1).await;
    request(
        &router,
        "GET",
        "/api/v2/health",
        "",
        true,
        "application/json",
    )
    .await;
    let (status, id, bytes) = request(
        &router,
        "GET",
        "/api/v2/health",
        "",
        true,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(value(&bytes)["log_id"], id);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn json_artifact_bytes_and_openapi_remain_original_formats() {
    let (app, router, _, _directory) = setup(100).await;
    let content = "{\"中文\": [1,2,3]}";
    let (_, _, bytes) = request(
        &router,
        "POST",
        "/api/v2/artifacts?filename=test.json",
        content,
        true,
        "application/octet-stream",
    )
    .await;
    let id = value(&bytes)["data"]["id"].as_str().unwrap().to_owned();
    let (status, _, downloaded) = request(
        &router,
        "GET",
        &format!("/api/v2/artifacts/{id}/content"),
        "",
        true,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(downloaded, content.as_bytes());
    let (_, log_id, bytes) = request(
        &router,
        "GET",
        "/api/v2/openapi.json",
        "",
        true,
        "application/json",
    )
    .await;
    let document = value(&bytes);
    assert_eq!(document["openapi"], "3.1.0");
    assert_eq!(document["x-deviceforge-log-id"], log_id);
    assert!(
        document["paths"]["/api/v2/jobs"]["get"]["responses"]["200"]["content"]["application/json"]
            ["schema"]["properties"]["data"]
            .is_object()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_success_protocol_errors_and_async_jobs_are_correlated() {
    let (app, router, observations, _directory) = setup(100).await;
    for (method, params) in [
        (
            "initialize",
            json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}),
        ),
        ("tools/list", json!({})),
        ("ping", json!({})),
    ] {
        let (_, id, bytes) = request(
            &router,
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
            true,
            "application/json",
        )
        .await;
        let result = value(&bytes);
        assert_eq!(
            result["result"]["_meta"]["deviceforge/log_id"], id,
            "{method}: {result}"
        );
    }
    for (method, params) in [
        ("tools/list", json!({"cursor":"bad"})),
        ("missing", json!({})),
        ("tools/call", json!({"wrong":true})),
    ] {
        let (_, id, bytes) = request(
            &router,
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}).to_string(),
            true,
            "application/json",
        )
        .await;
        let result = value(&bytes);
        assert_eq!(result["error"]["data"]["log_id"], id, "{method}: {result}");
    }
    let (_, origin, bytes) = request(&router, "POST", "/mcp", json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"plugin.test.echo","arguments":{}}}).to_string(), true, "application/json").await;
    let result = value(&bytes);
    assert_eq!(result["result"]["_meta"]["deviceforge/log_id"], origin);
    let job_id = result["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !app.get(&job_id).unwrap().status.is_terminal() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*observations.lock().unwrap(), vec![origin]);
    app.shutdown().await.unwrap();
}
