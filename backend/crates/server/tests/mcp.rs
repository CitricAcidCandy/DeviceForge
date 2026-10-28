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
            execution: None,
            id: "plugin.test.echo".into(),
            title: "回显".into(),
            input_schema: json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}),
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
async fn rpc(
    router: &Router,
    method: &str,
    params: Value,
    authorized: bool,
    origin: Option<&str>,
) -> (StatusCode, Value) {
    rpc_with_host(router, method, params, authorized, origin, "127.0.0.1:7031").await
}
async fn rpc_with_host(
    router: &Router,
    method: &str,
    mut params: Value,
    authorized: bool,
    origin: Option<&str>,
    host: &str,
) -> (StatusCode, Value) {
    params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"contract-tests","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}});
    let mut request = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", host)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", method);
    if let Some(name) = params["name"].as_str() {
        request = request.header("Mcp-Name", name);
    }
    if authorized {
        request = request.header("authorization", "Bearer test-mcp-token");
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let response = router
        .clone()
        .oneshot(
            request
                .body(Body::from(
                    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&body)})),
    )
}
#[tokio::test]
async fn mcp_discovers_and_submits_same_application_jobs() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), "test-mcp-token".into(), 100).unwrap();
    assert_eq!(
        rpc(&router, "tools/list", json!({}), false, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = rpc(&router, "tools/list", json!({}), true, None).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let tools = result["result"]["tools"]
        .as_array()
        .expect("工具发现应返回列表");
    assert!(tools.iter().any(|tool| tool["name"] == "plugin.test.echo"));
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "deviceforge.cancel_job")
    );
    let (status, result) = rpc(
        &router,
        "tools/call",
        json!({"name":"plugin.test.echo","arguments":{"value":9}}),
        true,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["result"]["isError"], false, "{result}");
    let id = result["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap();
    assert_eq!(app.get(id).unwrap().input, json!({"value":9}));
    let (_, detail) = rpc(
        &router,
        "tools/call",
        json!({"name":"deviceforge.get_job","arguments":{"id":id}}),
        true,
        None,
    )
    .await;
    assert_eq!(detail["result"]["structuredContent"]["id"], id);
    let (_, invalid) = rpc(
        &router,
        "tools/call",
        json!({"name":"plugin.test.echo","arguments":{"value":"bad"}}),
        true,
        None,
    )
    .await;
    assert!(invalid.get("error").is_some() || invalid["result"]["isError"] == true);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn browser_mcp_allows_preflight_and_catalog_from_loopback_and_lan() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), String::new(), 100).unwrap();
    for (host, origin) in [
        ("127.0.0.1:7031", "http://127.0.0.1:5173"),
        ("192.168.50.41:7031", "http://192.168.50.5:5173"),
    ] {
        let headers = "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name,mcp-session-id,last-event-id";
        let preflight = Request::builder()
            .method("OPTIONS")
            .uri("/mcp")
            .header("host", host)
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", headers)
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(preflight).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        let allowed = response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap();
        for requested in headers.split(',') {
            assert!(
                allowed.split(',').any(|value| value.trim() == requested),
                "浏览器 MCP 预检缺少请求头：{requested}"
            );
        }
        let exposed = response.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap();
        for required in [
            "mcp-session-id",
            "mcp-protocol-version",
            "x-deviceforge-log-id",
        ] {
            assert!(exposed.split(',').any(|value| value.trim() == required));
        }
        let (status, catalog) =
            rpc_with_host(&router, "tools/list", json!({}), false, Some(origin), host).await;
        assert_eq!(status, StatusCode::OK, "{catalog}");
        assert!(
            catalog["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "plugin.test.echo")
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_mcp_hosts_and_origins_still_limit_requests() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let config = apk_server::mcp::default_config()
        .with_allowed_hosts(["127.0.0.1"])
        .with_allowed_origins(["http://127.0.0.1:5173"]);
    let router =
        apk_server::router_with_mcp(app.clone(), "test-mcp-token".into(), 100, config).unwrap();
    for (host, origin, status) in [
        ("127.0.0.1:7031", "http://127.0.0.1:5173", StatusCode::OK),
        (
            "127.0.0.1:7031",
            "https://untrusted.example",
            StatusCode::FORBIDDEN,
        ),
        (
            "192.168.50.41:7031",
            "http://127.0.0.1:5173",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (actual, body) =
            rpc_with_host(&router, "tools/list", json!({}), true, Some(origin), host).await;
        assert_eq!(actual, status, "{body}");
    }
    assert_eq!(
        rpc(
            &router,
            "tools/list",
            json!({}),
            false,
            Some("http://127.0.0.1:5173")
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn optional_token_allows_mcp_discovery_and_task_submission_without_credentials() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), String::new(), 100).unwrap();
    let (status, discovered) = rpc(&router, "tools/list", json!({}), false, None).await;
    assert_eq!(status, StatusCode::OK, "{discovered}");
    assert!(
        discovered["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "plugin.test.echo")
    );
    let (status, submitted) = rpc(
        &router,
        "tools/call",
        json!({"name":"plugin.test.echo","arguments":{"value":9}}),
        false,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{submitted}");
    assert_eq!(submitted["result"]["isError"], false);
    let id = submitted["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap();
    assert_eq!(app.get(id).unwrap().input, json!({"value":9}));
    app.shutdown().await.unwrap();
}
