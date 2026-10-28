//! 不启动监听器的 HTTP/MCP 共用状态验证；不表示浏览器或生产包验收。
use apk_application::Application;
use apk_infrastructure::store::SqliteStore;
use apk_server::client_connection::ClientConnection;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

fn router() -> Router {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    apk_server::router(app, String::new(), 1000).unwrap()
}

async fn http(
    router: &Router,
    path: &str,
    body: Option<Value>,
    peer: Option<&str>,
    origin: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .uri(path)
        .header("host", "127.0.0.1:7031");
    if let Some(peer) = peer {
        request = request.extension(ConnectInfo(ClientConnection::from_addresses(
            peer.parse().unwrap(),
            None,
        )));
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let request = match body {
        Some(body) => request
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

async fn call(router: &Router, name: &str, input: Value) -> (StatusCode, Value) {
    http(
        router,
        "/api/v2/debugger/call",
        Some(json!({"name":name,"input":input})),
        Some("127.0.0.1:1000"),
        None,
    )
    .await
}

#[tokio::test]
async fn debugger_requires_real_loopback_but_regular_lan_api_is_unchanged() {
    let router = router();
    for peer in [None, Some("192.168.50.5:1000")] {
        let (status, body) = http(
            &router,
            "/api/v2/debugger/capabilities",
            None,
            peer,
            Some("http://localhost:5173"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "debugger_local_only");
        assert!(body["log_id"].is_string());
    }
    let (status, _) = http(
        &router,
        "/api/v2/health",
        None,
        Some("192.168.50.5:1000"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = http(
        &router,
        "/api/v2/debugger/capabilities",
        None,
        Some("[::1]:1000"),
        Some("http://localhost:5173"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["protocol_version"], 1);
    assert_eq!(body["data"]["production_acceptance_complete"], false);
}

#[tokio::test]
async fn selected_session_bridge_and_tool_share_one_state_without_replay() {
    let router = router();
    let (status, registered) = http(
        &router,
        "/api/v2/debugger/bridge/register",
        Some(json!({"plugins":[{"plugin_id":"example","generation":"1","version":"0.1.0"}]})),
        Some("127.0.0.1:1000"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let instance = registered["data"]["instance_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = json!({"target_kind":"browser","instance_id":instance,"plugin_id":"example","generation":"1"});
    let (status, opened) = call(
        &router,
        "deviceforge.debug_session",
        json!({"action":"open","target":target}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session = opened["data"]["session_id"].as_str().unwrap().to_owned();
    let waiting_router = router.clone();
    let waiting_session = session.clone();
    let waiting = tokio::spawn(async move {
        call(
            &waiting_router,
            "deviceforge.debug_inspect",
            json!({"session_id":waiting_session}),
        )
        .await
    });
    let mut commands = Vec::new();
    for _ in 0..4 {
        let (_, page) = http(
            &router,
            "/api/v2/debugger/bridge/poll",
            Some(json!({"instance_id":instance})),
            Some("127.0.0.1:1000"),
            None,
        )
        .await;
        commands = page["data"]["commands"].as_array().unwrap().clone();
        if !commands.is_empty() {
            break;
        }
    }
    assert_eq!(commands.len(), 1);
    let receipt = json!({"instance_id":instance,"command_id":commands[0]["command_id"],"plugin_id":"example","generation":"1","success":true,"response":{"source":"dom-accessible","code":"observed","mounted":true}});
    let (status, _) = http(
        &router,
        "/api/v2/debugger/bridge/ack",
        Some(receipt.clone()),
        Some("127.0.0.1:1000"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, result) = waiting.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["data"]["state"], "succeeded");
    assert_eq!(result["data"]["response"]["mounted"], true);
    let (status, body) = http(
        &router,
        "/api/v2/debugger/bridge/ack",
        Some(receipt),
        Some("127.0.0.1:1000"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "debugger_duplicate_receipt");
    let (status, closed) = call(
        &router,
        "deviceforge.debug_session",
        json!({"action":"close","session_id":session}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(closed["data"]["state"], "closed");
    let (_, heartbeat) = http(
        &router,
        "/api/v2/debugger/bridge/heartbeat",
        Some(json!({"instance_id":instance})),
        Some("127.0.0.1:1000"),
        None,
    )
    .await;
    assert_eq!(heartbeat["data"]["active_sessions"], json!([]));
}

async fn mcp(router: &Router, name: &str, arguments: Value, peer: Option<&str>) -> Value {
    let mut request = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "127.0.0.1:7031")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", name);
    if let Some(peer) = peer {
        request = request.extension(ConnectInfo(ClientConnection::from_addresses(
            peer.parse().unwrap(),
            None,
        )));
    }
    let response = router.clone().oneshot(request.body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":name,"arguments":arguments,"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"debugger-contract-tests","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}
    }}).to_string())).unwrap()).await.unwrap();
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn mcp_uses_same_targets_and_rejects_unverified_connections() {
    let router = router();
    let (_, registered) = http(
        &router,
        "/api/v2/debugger/bridge/register",
        Some(json!({"plugins":[{"plugin_id":"example","generation":"1"}]})),
        Some("127.0.0.1:1000"),
        None,
    )
    .await;
    let response = mcp(
        &router,
        "deviceforge.debug_targets",
        json!({}),
        Some("127.0.0.1:1000"),
    )
    .await;
    assert_eq!(
        response["result"]["structuredContent"]["browser_targets"][0]["instance_id"],
        registered["data"]["instance_id"]
    );
    assert!(response["result"]["_meta"]["deviceforge/log_id"].is_string());
    let response = mcp(&router, "deviceforge.debug_targets", json!({}), None).await;
    assert_eq!(response["result"]["isError"], true);
    assert_eq!(
        response["result"]["structuredContent"]["code"],
        "debugger_local_only"
    );
}

#[tokio::test]
async fn http_and_mcp_page_the_same_persistent_logs_past_two_hundred() {
    use apk_infrastructure::artifacts::FileArtifacts;
    use deviceforge_observability::{LogConfig, LogRuntime};
    let directory = tempfile::tempdir().unwrap();
    let logging = LogRuntime::open(LogConfig {
        directory: directory.path().join("logs"),
        queue_capacity: 8,
        retained_files: 2,
        level: tracing::level_filters::LevelFilter::INFO,
    })
    .unwrap();
    let lines = (0..235)
        .map(|index| {
            format!(
                "{}\n",
                json!({"timestamp":format!("2026-10-28T10:{:02}:{:02}Z",index / 60,index % 60),
                "level":"INFO","fields":{"message":format!("本机调试记录{index}")},
                "span":{"plugin_id":"shared-log-example","generation":"g1"}})
            )
        })
        .collect::<String>();
    std::fs::write(
        directory.path().join("logs/deviceforge.2026-10-28.jsonl"),
        lines,
    )
    .unwrap();
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    let router = apk_server::router_with_runtime(
        app.clone(),
        String::new(),
        1000,
        apk_server::mcp::default_config(),
        Arc::new(
            FileArtifacts::open(directory.path().join("artifacts"))
                .await
                .unwrap(),
        ),
        apk_server::runtime::RuntimeServices {
            logging: logging.metrics(),
            shutdown: tokio_util::sync::CancellationToken::new(),
            plugins: None,
        },
    )
    .unwrap();
    let query = json!({"source":"logs","plugin_id":"shared-log-example","generation":"g1","order":"desc","limit":100});
    let (status, first) = call(&router, "deviceforge.debug_events", query.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["data"]["entries"].as_array().unwrap().len(), 100);
    assert!(
        first["data"]["entries"][0]
            .to_string()
            .contains("本机调试记录234")
    );
    let mut next = query.clone();
    next["cursor"] = first["data"]["next_cursor"].clone();
    let second = mcp(
        &router,
        "deviceforge.debug_events",
        next,
        Some("127.0.0.1:1000"),
    )
    .await;
    let second = &second["result"]["structuredContent"];
    assert_eq!(second["entries"].as_array().unwrap().len(), 100);
    let mut next = query;
    next["cursor"] = second["next_cursor"].clone();
    let (status, third) = call(&router, "deviceforge.debug_events", next).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(third["data"]["entries"].as_array().unwrap().len(), 35);
    assert!(third["data"]["next_cursor"].is_null());
    assert!(
        third["data"]["entries"][34]
            .to_string()
            .contains("本机调试记录0")
    );
    app.shutdown().await.unwrap();
}
