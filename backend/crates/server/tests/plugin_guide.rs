//! 插件开发指南走真实 MCP 路由；空插件部署也能提供完整只读知识。
use apk_application::Application;
use apk_infrastructure::store::SqliteStore;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

const TOOL: &str = "deviceforge.get_plugin_development_guide";
const TOPICS: [&str; 7] = [
    "overview",
    "manifest",
    "sdk",
    "lifecycle",
    "examples",
    "packaging",
    "validation",
];

fn setup() -> (Arc<Application>, Router) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), String::new(), 1000).unwrap();
    (app, router)
}

async fn rpc(router: &Router, method: &str, mut params: Value) -> (String, Value) {
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {"name": "plugin-guide-tests", "version": "1"},
        "io.modelcontextprotocol/clientCapabilities": {}
    });
    let mut builder = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "127.0.0.1:7031")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", method)
        .header("x-deviceforge-log-id", "client-supplied-id");
    if let Some(name) = params["name"].as_str() {
        builder = builder.header("Mcp-Name", name);
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .body(Body::from(
                    json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let log_id = response.headers()["x-deviceforge-log-id"]
        .to_str()
        .unwrap()
        .to_owned();
    uuid::Uuid::parse_str(&log_id).expect("日志关联必须由服务器生成");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (log_id, serde_json::from_slice(&bytes).unwrap())
}

async fn guide(router: &Router, arguments: Value) -> Value {
    let (log_id, response) = rpc(
        router,
        "tools/call",
        json!({"name": TOOL, "arguments": arguments}),
    )
    .await;
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["_meta"]["deviceforge/log_id"], log_id,
        "{response}"
    );
    let result = &response["result"]["structuredContent"];
    assert!(result.is_object(), "指南应直接返回结构化知识：{response}");
    assert!(result.get("id").is_none(), "只读指南不应返回异步任务");
    assert!(
        response["result"]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "text"
                && item["text"].as_str().is_some_and(|text| !text.is_empty())),
        "不消费结构化内容的 MCP 客户端也应能读取指南"
    );
    result.clone()
}

#[tokio::test]
async fn guide_is_discoverable_with_read_only_schema_on_empty_deployment() {
    let (app, router) = setup();
    let (log_id, initialized) = rpc(
        &router,
        "initialize",
        json!({"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
    )
    .await;
    assert_eq!(initialized["result"]["_meta"]["deviceforge/log_id"], log_id);
    let instructions = initialized["result"]["instructions"].as_str().unwrap();
    assert!(
        instructions.contains(TOOL),
        "初始化应引导 AI 先读取开发指南"
    );
    let (log_id, listed) = rpc(&router, "tools/list", json!({})).await;
    assert_eq!(listed["result"]["_meta"]["deviceforge/log_id"], log_id);
    let tool = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == TOOL)
        .expect("未装配插件管理也应发现开发指南");
    assert_eq!(tool["annotations"]["readOnlyHint"], true);
    let schema = &tool["inputSchema"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["target"]));
    assert_eq!(
        schema["properties"]["target"]["enum"],
        json!(["frontend", "backend", "fullstack"])
    );
    assert_eq!(schema["properties"]["topic"]["enum"], json!(TOPICS));
    let default = guide(&router, json!({"target": "frontend"})).await;
    let overview = guide(&router, json!({"target": "frontend", "topic": "overview"})).await;
    assert_eq!(default, overview, "缺省主题必须与显式 overview 一致");
    assert!(app.list(8).unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn every_target_topic_returns_bounded_embedded_versioned_documents_without_jobs() {
    let (app, router) = setup();
    for target in ["frontend", "backend", "fullstack"] {
        for topic in TOPICS {
            let result = guide(&router, json!({"target": target, "topic": topic})).await;
            assert_eq!(result["guide_version"], 1);
            assert_eq!(result["host_version"], env!("CARGO_PKG_VERSION"));
            assert_eq!(result["frontend_sdk_version"], 2);
            assert_eq!(
                result["backend_task_protocol_versions"],
                json!([1, 2, 3, 4])
            );
            assert_eq!(result["backend_session_protocol_versions"], json!([5]));
            assert_eq!(result["target"], target);
            assert_eq!(result["topic"], topic);
            assert_eq!(result["available_topics"], json!(TOPICS));
            let documents = result["documents"].as_array().unwrap();
            assert!(!documents.is_empty(), "{target}/{topic} 不应为空");
            let expected_targets: &[&str] = if target == "fullstack" {
                &["frontend", "backend"]
            } else {
                &[target]
            };
            for expected in expected_targets {
                assert!(
                    documents
                        .iter()
                        .any(|document| document["target"] == *expected),
                    "{target}/{topic} 缺少 {expected} 指南"
                );
            }
            for document in documents {
                assert!(
                    expected_targets
                        .iter()
                        .any(|expected| document["target"] == *expected),
                    "{target}/{topic} 不应夹带其他目标资料"
                );
                assert_eq!(document["topic"], topic);
                let source = document["source"].as_str().unwrap();
                assert!(source.contains("docs/") && source.ends_with(".md"));
                assert!(!source.contains([':', '\\']), "来源应是可移植文档标识");
                let content = document["content"].as_str().unwrap();
                assert!(content.trim().len() >= 100, "{source} 应有实质知识");
                assert!(content.len() <= 128 * 1024, "{source} 超过单文档预算");
            }
            assert!(
                result.to_string().len() <= 512 * 1024,
                "单次指南超出读取预算"
            );
        }
    }
    assert!(
        app.list(8).unwrap().is_empty(),
        "21 种指南读取均不能创建任务"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_guide_arguments_are_correlated_protocol_errors_without_jobs() {
    let (app, router) = setup();
    let invalid = [
        json!({}),
        json!({"topic": "overview"}),
        json!({"target": null}),
        json!({"target": "Frontend"}),
        json!({"target": "server"}),
        json!({"target": "frontend", "topic": null}),
        json!({"target": "frontend", "topic": "unknown"}),
        json!({"target": "frontend", "topic": 1}),
        json!({"target": "frontend", "extra": true}),
        json!({"target": "frontend", "topic": "overview", "limit": 10}),
        Value::Null,
        json!([]),
        json!("frontend"),
    ];
    for arguments in invalid {
        let (log_id, response) = rpc(
            &router,
            "tools/call",
            json!({"name": TOOL, "arguments": arguments}),
        )
        .await;
        assert_eq!(response["error"]["code"], -32602, "{arguments}: {response}");
        assert_eq!(response["error"]["data"]["log_id"], log_id);
        assert!(response.get("result").is_none(), "错误不能包装成异步任务");
    }
    assert!(app.list(8).unwrap().is_empty(), "参数错误不应留下任何任务");
    app.shutdown().await.unwrap();
}
