use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, Operation, Result,
    interactive::{SessionDefinition, SessionLaunch, SessionProvider, SessionRequest},
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::store::SqliteStore;
use apk_server::client_connection::ClientConnection;
use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[derive(Default)]
struct Capture(Mutex<Vec<SessionRequest>>);

impl SessionProvider for Capture {
    fn definitions(&self) -> Vec<SessionDefinition> {
        vec![SessionDefinition {
            id: "plugin.client.live".into(),
            title: "可信客户端上下文".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
            output_retention: Default::default(),
        }]
    }

    fn open(&self, request: SessionRequest, _: CancellationToken) -> Result<SessionLaunch> {
        self.0.lock().unwrap().push(request);
        Err(Error::Dependency("本测试只捕获准入上下文".into()))
    }
}

struct ClientExecutor(Arc<Capture>);

#[async_trait]
impl Executor for ClientExecutor {
    fn operations(&self) -> Vec<Operation> {
        Vec::new()
    }

    fn session_provider(&self) -> Option<Arc<dyn SessionProvider>> {
        Some(self.0.clone())
    }

    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        Err(Error::NotFound("普通操作未贡献".into()))
    }
}

struct Catalog;

#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, _: &str) -> Result<PluginContribution> {
        Err(Error::NotFound("测试只使用显式贡献".into()))
    }
}

async fn setup(token: &str) -> (Arc<Application>, Router, Arc<Capture>) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let capture = Arc::new(Capture::default());
    let plugins = PluginService::new(app.clone(), Arc::new(Catalog), Default::default());
    plugins
        .seed(PluginContribution {
            id: "client".into(),
            version: "1".into(),
            executor: Arc::new(ClientExecutor(capture.clone())),
        })
        .await
        .unwrap();
    let router = apk_server::router(app.clone(), token.into(), 1000).unwrap();
    (app, router, capture)
}

#[tokio::test]
async fn http_client_uses_socket_metadata_and_ignores_forwarded_and_business_claims() {
    let (app, router, capture) = setup("").await;
    for (peer, expected) in [
        ("127.0.0.1:17000", true),
        ("192.168.50.5:17000", true),
        ("192.168.50.6:17000", false),
    ] {
        let connection = ClientConnection::from_addresses(
            peer.parse().unwrap(),
            Some("192.168.50.5:7031".parse().unwrap()),
        );
        let request = Request::builder()
            .method("POST")
            .uri("/api/v2/sessions")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "127.0.0.1")
            .header("forwarded", "for=127.0.0.1")
            .extension(ConnectInfo(connection))
            .body(Body::from(
                json!({
                    "operation":"plugin.client.live", "input":{"is_local":true,"master":true},
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::BAD_GATEWAY
        );
        let captured = capture.0.lock().unwrap().last().unwrap().clone();
        let client = captured.client.unwrap();
        assert_eq!(client.is_local, expected);
        assert_eq!(client.id, captured.session_id);
        assert!(uuid::Uuid::parse_str(&client.id).is_ok());
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_transport_metadata_and_direct_calls_do_not_grant_local_control() {
    let (app, router, capture) = setup("").await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/v2/sessions")
        .header("content-type", "application/json")
        .header("x-forwarded-for", "127.0.0.1")
        .body(Body::from(
            json!({"operation":"plugin.client.live","input":{}}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        router.oneshot(request).await.unwrap().status(),
        StatusCode::BAD_GATEWAY
    );
    assert!(capture.0.lock().unwrap().last().unwrap().client.is_none());
    assert!(app.open_session("plugin.client.live", json!({})).is_err());
    assert!(capture.0.lock().unwrap().last().unwrap().client.is_none());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn clients_cannot_supply_the_transport_context_in_the_http_envelope() {
    let (app, router, capture) = setup("").await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/v2/sessions")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "operation":"plugin.client.live","input":{},
                "client":{"id":"forged","is_local":true},
            })
            .to_string(),
        ))
        .unwrap();
    assert_eq!(
        router.oneshot(request).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert!(capture.0.lock().unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn accepted_tcp_socket_injects_a_local_identity_without_forwarded_headers() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (app, router, capture) = setup("").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let service_shutdown = shutdown.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<apk_server::client_connection::ClientConnection>(),
        )
        .with_graceful_shutdown(service_shutdown.cancelled_owned())
        .await
        .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let body = json!({"operation":"plugin.client.live","input":{}}).to_string();
    let request = format!(
        "POST /api/v2/sessions HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        socket.read_to_end(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    shutdown.cancel();
    server.await.unwrap();
    assert!(response.starts_with(b"HTTP/1.1 502"));
    let captured = capture.0.lock().unwrap().last().unwrap().clone();
    let client = captured.client.unwrap();
    assert!(client.is_local);
    assert_eq!(client.id, captured.session_id);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cors_preflight_allows_lan_bearer_requests_without_cookie_credentials() {
    let (app, router, _) = setup("required-token").await;
    let preflight = Request::builder()
        .method("OPTIONS")
        .uri("/api/v2/sessions")
        .header("origin", "http://192.168.50.5:5173")
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "authorization,content-type",
        )
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(preflight).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    assert!(
        response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("authorization")
    );
    assert!(
        !response
            .headers()
            .contains_key("access-control-allow-credentials")
    );
    assert!(response.headers().contains_key("x-deviceforge-log-id"));
    let request = Request::builder()
        .uri("/api/v2/session-definitions")
        .header("origin", "http://192.168.50.5:5173")
        .body(Body::empty())
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    assert!(
        response.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .contains("x-deviceforge-log-id")
    );
    app.shutdown().await.unwrap();
}
