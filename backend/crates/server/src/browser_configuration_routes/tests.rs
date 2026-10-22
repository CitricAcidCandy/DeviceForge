use apk_application::{Application, browser_configurations::BrowserConfigurationService};
use apk_infrastructure::{browser_configurations::FileBrowserConfigurations, store::SqliteStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    app: Arc<Application>,
    router: Router,
}

impl Harness {
    async fn new(configured: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            8,
        )
        .unwrap();
        let browser = if configured {
            Some(BrowserConfigurationService::new(
                FileBrowserConfigurations::open(&directory.path().join("browser"))
                    .await
                    .unwrap(),
            ))
        } else {
            None
        };
        let router = crate::build_router(
            app.clone(),
            String::new(),
            1000,
            crate::mcp::default_config(),
            None,
            None,
            None,
            None,
            browser,
        )
        .unwrap();
        Self {
            _directory: directory,
            app,
            router,
        }
    }

    async fn request(&self, method: &str, id: &str, body: String) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v2/browser-plugin-configurations/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let log_id = response.headers()["x-deviceforge-log-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 512 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(value["log_id"], log_id);
        uuid::Uuid::parse_str(&log_id).unwrap();
        assert!(
            !value
                .to_string()
                .contains(&self._directory.path().to_string_lossy().to_string())
        );
        (status, value)
    }

    async fn close(self) {
        self.app.shutdown().await.unwrap();
    }
}

fn record(revision: &str) -> Value {
    json!({
        "version":3,"values":{"token":"raw-browser-sentinel","count":4},
        "revision":revision,"applied":"defaults","sensitivePaths":["/token","/history"]
    })
}

#[tokio::test]
async fn browser_configuration_http_roundtrip_is_raw_and_cas_preserves_the_complete_record() {
    let harness = Harness::new(true).await;
    let (status, body) = harness.request("GET", "bundled.demo", String::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"]["record"].is_null());
    let initial = record("defaults");
    let (status, body) = harness
        .request(
            "PATCH",
            "bundled.demo",
            json!({"expected_revision":null,"record":initial}).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["record"], initial);
    let next = record(&uuid::Uuid::new_v4().to_string());
    let (status, body) = harness
        .request(
            "PATCH",
            "bundled.demo",
            json!({"expected_revision":"defaults","record":next}).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["record"], next);
    let (status, body) = harness.request("GET", "bundled.demo", String::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["record"], next);
    for expected in [Value::Null, json!("defaults")] {
        let (status, body) = harness
            .request(
                "PATCH",
                "bundled.demo",
                json!({"expected_revision":expected,"record":initial}).to_string(),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "conflict");
    }
    harness.close().await;
}

#[tokio::test]
async fn browser_configuration_http_rejects_bad_contracts_and_keeps_absence() {
    let harness = Harness::new(true).await;
    for body in [
        "{".into(),
        json!({"record":record("defaults")}).to_string(),
        json!({"expected_revision":null,"record":record("defaults"),"extra":true}).to_string(),
        json!({"expected_revision":0,"record":record("defaults")}).to_string(),
        json!({"expected_revision":null,"record":record("not-a-revision")}).to_string(),
    ] {
        let (status, body) = harness.request("PATCH", "demo", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_input");
    }
    for values in [json!([]), json!(null), json!("text")] {
        let mut invalid = record("defaults");
        invalid["values"] = values;
        assert_eq!(
            harness
                .request(
                    "PATCH",
                    "demo",
                    json!({"expected_revision":null,"record":invalid}).to_string()
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    for id in ["UPPER", "builtin.demo", "%2e%2e%2foutside"] {
        assert_eq!(
            harness.request("GET", id, String::new()).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(harness.request("GET", "demo", String::new()).await.1["data"]["record"].is_null());
    harness.close().await;
}

#[tokio::test]
async fn browser_configuration_http_size_limit_and_unconfigured_error_are_wrapped() {
    let harness = Harness::new(true).await;
    let mut large = record("defaults");
    large["values"] = json!({"large":"x".repeat(256 * 1024)});
    let (status, body) = harness
        .request(
            "PATCH",
            "demo",
            json!({"expected_revision":null,"record":large}).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"]["code"], "payload_too_large");
    harness.close().await;
    let harness = Harness::new(false).await;
    let (status, body) = harness.request("GET", "demo", String::new()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "not_configured");
    harness.close().await;
}

#[test]
fn browser_configuration_openapi_exposes_the_record_and_required_nullable_cas() {
    let document = crate::openapi_document();
    let path = &document["paths"]["/api/v2/browser-plugin-configurations/{id}"];
    assert!(path["get"]["responses"]["200"]["content"]["application/json"]["schema"]["properties"]["data"]["properties"].get("record").is_some());
    assert!(path["patch"]["responses"].get("413").is_some());
    assert!(path["get"]["responses"].get("413").is_some());
    let view = &document["components"]["schemas"]["BrowserConfigurationView"];
    assert!(
        view["required"]
            .as_array()
            .unwrap()
            .contains(&json!("record"))
    );
    let patch = &document["components"]["schemas"]["BrowserConfigurationPatch"];
    assert!(
        patch["required"]
            .as_array()
            .unwrap()
            .contains(&json!("expected_revision"))
    );
    let record = &document["components"]["schemas"]["BrowserConfigurationRecord"];
    assert!(record["properties"].get("sensitivePaths").is_some());
    assert!(record["properties"].get("sensitive_paths").is_none());
}
