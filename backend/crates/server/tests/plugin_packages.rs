use apk_application::{
    Application, plugin_lifecycle::PluginService, plugin_packages::PackageService,
};
use apk_infrastructure::{
    artifacts::FileArtifacts, plugin_catalog::FilePluginCatalog,
    plugin_packages::FilePluginPackages, store::SqliteStore,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use deviceforge_observability::{LogConfig, LogRuntime};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Write},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    _logging: LogRuntime,
    router: Router,
    app: Arc<Application>,
    plugins: Arc<PluginService>,
}
impl Harness {
    async fn new(token: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = Arc::new(
            FileArtifacts::open(directory.path().join("artifacts"))
                .await
                .unwrap(),
        );
        let server_root = directory.path().join("server");
        let store = Arc::new(
            FilePluginPackages::open(&server_root, &directory.path().join("browser"), None)
                .await
                .unwrap(),
        );
        let catalog = Arc::new(
            FilePluginCatalog::open(&server_root, artifacts.clone())
                .await
                .unwrap(),
        );
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            8,
        )
        .unwrap();
        let plugins = PluginService::new(app.clone(), catalog, Default::default());
        let packages = PackageService::new(store, plugins.clone());
        let logging = LogRuntime::open(LogConfig {
            directory: directory.path().join("logs"),
            queue_capacity: 32,
            retained_files: 2,
            level: tracing::level_filters::LevelFilter::INFO,
        })
        .unwrap();
        let runtime = apk_server::runtime::RuntimeServices {
            logging: logging.metrics(),
            shutdown: CancellationToken::new(),
            plugins: Some(plugins.clone()),
        };
        let router = apk_server::router_with_packages(
            app.clone(),
            token.into(),
            1000,
            apk_server::mcp::default_config(),
            artifacts,
            runtime,
            packages,
        )
        .unwrap();
        Self {
            _directory: directory,
            _logging: logging,
            router,
            app,
            plugins,
        }
    }
    async fn close(self) {
        self.plugins.close();
        self.plugins.wait().await;
        self.app.shutdown().await.unwrap();
    }
}
fn package(browser: bool, invalid_schema: bool) -> Vec<u8> {
    let kind = if browser { "browser" } else { "server" };
    let runtime = if browser { "browser" } else { "native" };
    let manifest = if browser {
        json!({"id":"httpdemo","version":"1.0.0","api_version":2})
    } else {
        json!({"id":"httpdemo","version":"1.0.0","protocol_version":3,"operations":[{"name":"work","title":"任务","input_schema":if invalid_schema { json!({"type":"array"}) } else { json!({"type":"object"}) }}]})
    };
    let files=vec![
        ("package.json",serde_json::to_vec(&json!({"version":"1.0.0","deviceforge":{"kind":kind,"manifest":"portable.json","entrypoints":{"any":{"runtime":runtime,"path":"dist/main.js"}}}})).unwrap()),
        ("portable.json",serde_json::to_vec(&manifest).unwrap()),
        ("dist/main.js",b"import './child.js'; export default {};".to_vec()),
        ("dist/child.js",b"export const child = true;".to_vec()),
        ("dist/data.json",br#"{"bytes":"unchanged"}"#.to_vec())
    ];
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    authorized: bool,
    media: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", media)
        .header("host", "localhost");
    if authorized {
        request = request.header("authorization", "Bearer test-token");
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap().to_vec();
    (parts.status, parts.headers, bytes)
}
fn envelope(headers: &axum::http::HeaderMap, bytes: &[u8]) -> Value {
    let value: Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(
        value["log_id"].as_str().unwrap(),
        headers["x-deviceforge-log-id"].to_str().unwrap()
    );
    value
}

#[tokio::test]
async fn package_extractor_failures_always_use_v2_error_envelopes() {
    let harness = Harness::new("").await;
    for (method, path) in [
        ("GET", "/api/v2/plugin-packages/invalid"),
        ("DELETE", "/api/v2/plugin-packages/invalid/httpdemo"),
        ("POST", "/api/v2/plugin-packages/invalid?format=zip"),
        ("POST", "/api/v2/plugin-packages/browser"),
        ("POST", "/api/v2/plugin-packages/browser?format=bad"),
        ("POST", "/api/v2/plugin-packages/browser?format=zip&extra=1"),
        (
            "POST",
            "/api/v2/plugin-packages/browser?format=zip&format=tgz",
        ),
    ] {
        let (status, headers, bytes) = request(
            &harness.router,
            method,
            path,
            vec![],
            false,
            "application/zip",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}");
        assert_eq!(envelope(&headers, &bytes)["error"]["code"], "invalid_input");
    }
    harness.close().await;
}

#[tokio::test]
async fn browser_assets_and_run_aliases_are_public_raw_bytes_while_management_requires_configured_token()
 {
    let harness = Harness::new("test-token").await;
    let (status, _, _) = request(
        &harness.router,
        "GET",
        "/api/v2/plugin-packages/browser",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, headers, bytes) = request(
        &harness.router,
        "POST",
        "/api/v2/plugin-packages/browser?format=zip",
        package(true, false),
        true,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        envelope(&headers, &bytes)["data"]["entry_path"],
        "dist/main.js"
    );
    for path in [
        "/api/v2/browser-plugins/httpdemo/assets/dist/data.json",
        "/api/v2/browser-plugins/httpdemo/runs/11111111-1111-4111-8111-111111111111/assets/dist/data.json",
    ] {
        let (status, headers, bytes) = request(
            &harness.router,
            "GET",
            path,
            vec![],
            false,
            "application/json",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, br#"{"bytes":"unchanged"}"#);
        assert_eq!(headers["content-type"], "application/json");
        assert!(headers.contains_key("x-deviceforge-log-id"));
        let (status, headers, bytes) = request(
            &harness.router,
            "HEAD",
            path,
            vec![],
            false,
            "application/json",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(bytes.is_empty());
        assert_eq!(headers["content-length"], "21");
    }
    for run in ["run-a", "run-b"] {
        let (status, headers, bytes) = request(
            &harness.router,
            "GET",
            &format!("/api/v2/browser-plugins/httpdemo/runs/{run}/assets/dist/child.js"),
            vec![],
            false,
            "application/json",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
        assert_eq!(bytes, b"export const child = true;");
    }
    let (status, headers, bytes) = request(
        &harness.router,
        "GET",
        "/api/v2/browser-plugins/httpdemo/runs/invalid.id/assets/dist/child.js",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(envelope(&headers, &bytes)["error"]["code"], "invalid_input");
    let (status, _, _) = request(
        &harness.router,
        "DELETE",
        "/api/v2/plugin-packages/browser/httpdemo",
        vec![],
        true,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    harness.close().await;
}

#[tokio::test]
async fn server_package_validation_rolls_back_and_loaded_deployments_cannot_be_deleted() {
    let harness = Harness::new("").await;
    let (status, headers, bytes) = request(
        &harness.router,
        "POST",
        "/api/v2/plugin-packages/server?format=zip",
        package(false, true),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(envelope(&headers, &bytes)["error"]["code"], "invalid_input");
    let (status, _, bytes) = request(
        &harness.router,
        "GET",
        "/api/v2/plugin-packages/server",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["data"],
        json!([])
    );
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugin-packages/server?format=zip",
        package(false, false),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(harness.app.operations().is_empty());
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugins/httpdemo/load",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, headers, bytes) = request(
        &harness.router,
        "DELETE",
        "/api/v2/plugin-packages/server/httpdemo",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(envelope(&headers, &bytes)["error"]["code"], "conflict");
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugins/httpdemo/unload",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = request(
        &harness.router,
        "DELETE",
        "/api/v2/plugin-packages/server/httpdemo",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    harness.close().await;
}

#[test]
fn openapi_has_optional_auth_and_both_raw_asset_aliases() {
    let document = apk_server::openapi_document();
    assert_eq!(document["security"], json!([{}, {"bearerAuth":[]}]));
    for path in [
        "/api/v2/browser-plugins/{id}/assets/{path}",
        "/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{path}",
    ] {
        assert_eq!(document["paths"][path]["get"]["security"], json!([]));
        assert_eq!(document["paths"][path]["head"]["security"], json!([]));
        assert_eq!(
            document["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
                ["format"],
            "binary"
        );
    }
}
