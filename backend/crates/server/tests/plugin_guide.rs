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
const TOPICS: [&str; 8] = [
    "overview",
    "manifest",
    "sdk",
    "lifecycle",
    "examples",
    "packaging",
    "dependencies",
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
    let status = response.status();
    let log_id = response.headers()["x-deviceforge-log-id"]
        .to_str()
        .unwrap()
        .to_owned();
    uuid::Uuid::parse_str(&log_id).expect("日志关联必须由服务器生成");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let malformed_arguments = params
        .get("arguments")
        .is_some_and(|value| !value.is_object() && !value.is_null());
    assert_eq!(
        status,
        if malformed_arguments {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::OK
        },
        "请求 {params} 返回 {}",
        String::from_utf8_lossy(&bytes)
    );
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
    assert_eq!(tool["annotations"]["destructiveHint"], false);
    assert_eq!(tool["annotations"]["idempotentHint"], true);
    assert_eq!(tool["annotations"]["openWorldHint"], false);
    let schema = &tool["inputSchema"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["target"]));
    assert_eq!(
        schema["properties"]["target"]["enum"],
        json!(["frontend", "backend", "fullstack"])
    );
    assert_eq!(schema["properties"]["topic"]["enum"], json!(TOPICS));
    assert_eq!(schema["properties"]["topic"]["default"], "overview");
    for target in ["frontend", "backend", "fullstack"] {
        let default = guide(&router, json!({"target": target})).await;
        let overview = guide(&router, json!({"target": target, "topic": "overview"})).await;
        assert_eq!(
            default, overview,
            "{target} 缺省主题必须与显式 overview 一致"
        );
    }
    assert!(app.list(8).unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn every_target_topic_returns_bounded_embedded_versioned_documents_without_jobs() {
    let (app, router) = setup();
    for target in ["frontend", "backend", "fullstack"] {
        for topic in TOPICS {
            let result = guide(&router, json!({"target": target, "topic": topic})).await;
            assert_eq!(result["guide_version"], 3);
            assert_eq!(result["release_format_versions"], json!([1, 2]));
            assert_eq!(result["release_host_api_versions"], json!([2]));
            assert_eq!(result["host_version"], env!("CARGO_PKG_VERSION"));
            assert_eq!(result["frontend_sdk_version"], 2);
            assert_eq!(
                result["backend_task_protocol_versions"],
                json!([1, 2, 3, 4, 6])
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
            assert_eq!(documents.len(), expected_targets.len());
            for expected in expected_targets {
                let document = documents
                    .iter()
                    .find(|document| document["target"] == *expected)
                    .unwrap_or_else(|| panic!("{target}/{topic} 缺少 {expected} 指南"));
                assert_eq!(
                    document["source"],
                    format!("{expected}/docs/guides/plugin-development/{topic}.md")
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
        "24 种指南读取均不能创建任务"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn fullstack_knowledge_covers_release_resources_and_compatibility_without_jobs() {
    let (app, router) = setup();
    let overview = guide(&router, json!({"target":"fullstack","topic":"overview"})).await;
    let workflow = overview["fullstack_workflow"].as_str().unwrap();
    for term in [
        "release.json",
        "configuration_required",
        "DEVICEFORGE_PLUGIN_RESOURCES",
        "/api/v1/capabilities",
        "旧单组件",
        "catalog",
    ] {
        assert!(workflow.contains(term), "配套流程缺少 {term}");
    }
    for target in ["frontend", "backend"] {
        for (topic, terms) in [
            ("manifest", vec!["release.json", "any_of", "bindings"]),
            (
                "sdk",
                vec!["DEVICEFORGE_PLUGIN_RESOURCES", "managed_resources", "原值"],
            ),
            (
                "lifecycle",
                vec!["expected_revision", "configuration_required", "旧"],
            ),
            ("examples", vec!["release.json", "blobs/"]),
            (
                "packaging",
                vec!["/api/v1/capabilities", "/api/v1/catalog", "离线"],
            ),
            ("validation", vec!["缺", "SHA-256", "配置"]),
        ] {
            let result = guide(&router, json!({"target":target,"topic":topic})).await;
            let content = result["documents"][0]["content"].as_str().unwrap();
            for term in terms {
                assert!(content.contains(term), "{target}/{topic} 缺少 {term}");
            }
        }
    }
    assert!(app.list(8).unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_guide_arguments_are_correlated_errors_without_jobs() {
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
        if arguments.is_object() || arguments.is_null() {
            // 对象字段校验沿现有工具错误契约返回；空参数等价于没有提供字段。
            assert_eq!(
                response["result"]["isError"], true,
                "{arguments}: {response}"
            );
            assert_eq!(
                response["result"]["structuredContent"]["code"],
                "invalid_input"
            );
            assert_eq!(response["result"]["_meta"]["deviceforge/log_id"], log_id);
            assert!(response["result"]["structuredContent"].get("id").is_none());
        } else {
            // rmcp 3.5 将无法反序列化的调用结构判为未知方法，由传输层拒绝。
            assert_eq!(response["error"]["code"], -32601, "{arguments}: {response}");
            assert_eq!(response["error"]["data"]["log_id"], log_id);
            assert!(response.get("result").is_none());
        }
    }
    assert!(app.list(8).unwrap().is_empty(), "参数错误不应留下任何任务");
    app.shutdown().await.unwrap();
}
