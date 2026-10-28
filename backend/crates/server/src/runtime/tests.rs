use super::*;
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use deviceforge_observability::{LogConfig, LogRuntime};
use tower::ServiceExt;

#[tokio::test]
async fn log_lookup_uses_v2_envelope_and_validates_id_without_starting_a_service() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    let runtime = LogRuntime::open(LogConfig {
        directory: logs.clone(),
        queue_capacity: 8,
        retained_files: 2,
        level: tracing::level_filters::LevelFilter::INFO,
    })
    .unwrap();
    let id = "d3be1c0c-eee8-43a6-9f47-f963ddbfc725";
    std::fs::write(logs.join("deviceforge.2026-10-27.jsonl"), format!("{}\n", json!({
        "timestamp":"2026-10-27T10:00:00Z", "level":"INFO", "fields":{"message":"响应已建立", "status":200},
        "span":{"log_id":id,"route":"/api/v2/jobs/{id}","method":"GET"}
    }))).unwrap();
    let app = apk_application::Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let artifacts = Arc::new(
        FileArtifacts::open(root.path().join("artifacts"))
            .await
            .unwrap(),
    );
    let router = crate::router_with_runtime(
        app.clone(),
        String::new(),
        1000,
        crate::mcp::default_config(),
        artifacts,
        RuntimeServices {
            logging: runtime.metrics(),
            shutdown: CancellationToken::new(),
            plugins: None,
        },
    )
    .unwrap();
    for (suffix, status) in [
        (format!("?log_id={id}"), StatusCode::OK),
        ("?q=%E5%93%8D%E5%BA%94&order=desc".into(), StatusCode::OK),
        ("?q=%E5%93%8D%E5%BA%94&order=asc".into(), StatusCode::OK),
        ("?log_id=broken".into(), StatusCode::BAD_REQUEST),
        ("?log_id=../private".into(), StatusCode::BAD_REQUEST),
        (format!("?log_id={id}&q=both"), StatusCode::BAD_REQUEST),
        ("?q=".into(), StatusCode::BAD_REQUEST),
        ("?q=valid&order=broken".into(), StatusCode::BAD_REQUEST),
        (String::new(), StatusCode::BAD_REQUEST),
    ] {
        let by_keyword = suffix.starts_with("?q=");
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v2/diagnostics/logs{suffix}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert!(body["log_id"].is_string());
        if status == StatusCode::OK {
            if by_keyword {
                assert!(body["data"]["log_id"].is_null());
            } else {
                assert_eq!(body["data"]["log_id"], id);
            }
            assert_eq!(body["data"]["entries"][0]["status"], 200);
            assert_eq!(body["data"]["entries"][0]["log_id"], id);
            assert!(body["data"]["job_ids"].as_array().unwrap().is_empty());
        } else {
            assert_eq!(body["error"]["code"], "invalid_input");
        }
    }
    let schema = crate::openapi::document();
    assert_eq!(
        schema["paths"]["/api/v2/diagnostics/logs"]["get"]["parameters"][0]["name"],
        "log_id"
    );
    app.shutdown().await.unwrap();
}
