use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, Operation, Result,
    interactive::{SessionDefinition, SessionLaunch, SessionProvider, SessionRequest},
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use std::{pin::Pin, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

pub type Events = Pin<Box<dyn Stream<Item = std::result::Result<Bytes, axum::Error>> + Send>>;

struct Catalog;
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, _: &str) -> Result<PluginContribution> {
        Err(Error::NotFound("测试只发布明确构造的贡献".into()))
    }
}

struct Echo {
    operations: usize,
    session: bool,
}
#[async_trait]
impl Executor for Echo {
    fn operations(&self) -> Vec<Operation> {
        (0..self.operations)
            .map(|ordinal| Operation {
                execution: None,
                id: format!("plugin.test.echo_{ordinal}"),
                title: "目录变化回显".into(),
                input_schema: json!({"type":"object"}),
            })
            .collect()
    }
    fn session_provider(&self) -> Option<Arc<dyn SessionProvider>> {
        self.session
            .then(|| Arc::new(SessionOnly) as Arc<dyn SessionProvider>)
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        Ok(input)
    }
}
struct SessionOnly;
impl SessionProvider for SessionOnly {
    fn definitions(&self) -> Vec<SessionDefinition> {
        vec![SessionDefinition {
            id: "plugin.test.live".into(),
            title: "目录变化交互贡献".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
            output_retention: Default::default(),
        }]
    }
    fn open(&self, _: SessionRequest, _: CancellationToken) -> Result<SessionLaunch> {
        Err(Error::Dependency("目录验证不启动交互工具".into()))
    }
}

pub fn contribution(operations: usize, session: bool) -> PluginContribution {
    PluginContribution {
        id: "test".into(),
        version: "1".into(),
        executor: Arc::new(Echo {
            operations,
            session,
        }),
    }
}

pub fn setup(
    token: &str,
) -> (
    Arc<Application>,
    Arc<PluginService>,
    Router,
    CancellationToken,
) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let plugins = PluginService::new(app.clone(), Arc::new(Catalog), Default::default());
    let shutdown = CancellationToken::new();
    let mut config = apk_server::mcp::default_config();
    config.cancellation_token = shutdown.clone();
    config.sse_keep_alive = None;
    let router = apk_server::router_with_mcp(app.clone(), token.into(), 1000, config).unwrap();
    (app, plugins, router, shutdown)
}

pub async fn request(router: &Router, method: &str, mut params: Value, token: &str) -> Response {
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{"name":"目录通知验证","version":"1"},
        "io.modelcontextprotocol/clientCapabilities":{}
    });
    let mut builder = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "127.0.0.1:7031")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", method);
    if !token.is_empty() {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    router
        .clone()
        .oneshot(
            builder
                .body(Body::from(
                    json!({
                        "jsonrpc":"2.0", "id":17, "method":method, "params":params
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

pub async fn json_result(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

pub async fn subscription(router: &Router, token: &str) -> (Events, String) {
    let response = request(
        router,
        "subscriptions/listen",
        json!({"notifications":{"toolsListChanged":true}}),
        token,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let log_id = response.headers()["x-deviceforge-log-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let mut events: Events = Box::pin(response.into_body().into_data_stream());
    let acknowledgment = event(&mut events).await;
    assert_eq!(
        acknowledgment["method"],
        "notifications/subscriptions/acknowledged"
    );
    assert_eq!(
        acknowledgment["params"]["notifications"]["toolsListChanged"],
        true
    );
    (events, log_id)
}

pub async fn event(events: &mut Events) -> Value {
    let bytes = tokio::time::timeout(Duration::from_secs(3), events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let data = text
        .lines()
        .find_map(|line| {
            line.strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
        })
        .unwrap_or_else(|| panic!("缺少SSE数据：{text}"));
    serde_json::from_str(data).unwrap()
}

pub async fn invalidation(events: &mut Events, log_id: &str) {
    let notification = event(events).await;
    assert_eq!(notification["method"], "notifications/tools/list_changed");
    assert_eq!(
        notification["params"]["_meta"]["deviceforge/log_id"],
        log_id
    );
    assert_eq!(
        notification["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
        17
    );
}
