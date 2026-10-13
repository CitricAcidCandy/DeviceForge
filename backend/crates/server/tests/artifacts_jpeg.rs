use apk_application::{Application, artifacts::ArtifactOperations};
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    bytes: Vec<u8>,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/octet-stream")
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn read_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn jpeg_upload_http_download_and_mcp_metadata_share_one_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let application = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(ArtifactOperations(artifacts.clone()))],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router_with_artifacts(
        application.clone(),
        String::new(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    let bytes = vec![
        0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0,
        63, 0, 1, 0xff, 0, 2, 0xff, 0xd9,
    ];
    let response = call(
        &router,
        "POST",
        "/api/v2/artifacts?filename=screenshot.jpeg",
        bytes.clone(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let log_id = response.headers()["x-deviceforge-log-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let uploaded = read_json(response).await;
    assert_eq!(uploaded["log_id"], log_id);
    let metadata = &uploaded["data"];
    assert_eq!(metadata["media_type"], "image/jpeg");
    assert_eq!(metadata["size"], bytes.len());
    let id = metadata["id"].as_str().unwrap();
    for version in ["v1", "v2"] {
        let response = call(
            &router,
            "GET",
            &format!("/api/{version}/artifacts/{id}/content"),
            Vec::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/jpeg");
        assert!(response.headers().contains_key("x-deviceforge-log-id"));
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(
            to_bytes(response.into_body(), 1024 * 1024).await.unwrap(),
            bytes
        );
    }
    let request = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "127.0.0.1:7031")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "artifact.inspect")
        .body(Body::from(
            json!({
                "jsonrpc":"2.0","id":1,"method":"tools/call","params":{
                    "name":"artifact.inspect","arguments":{"artifact_id":id},"_meta":{
                        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                        "io.modelcontextprotocol/clientInfo":{"name":"jpeg-contract","version":"1"},
                        "io.modelcontextprotocol/clientCapabilities":{}
                    }
                }
            })
            .to_string(),
        ))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key("x-deviceforge-log-id"));
    let result = read_json(response).await;
    assert_eq!(result["result"]["isError"], false);
    let job_id = result["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap();
    let job = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let job = application.get(job_id).unwrap();
            if job.status.is_terminal() {
                break job;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(job.result.as_ref().unwrap(), metadata);
    for invalid in [bytes[..bytes.len() - 1].to_vec(), b"not-jpeg".to_vec()] {
        let response = call(
            &router,
            "POST",
            "/api/v2/artifacts?filename=invalid.jpg",
            invalid,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.headers().contains_key("x-deviceforge-log-id"));
        let error = read_json(response).await;
        assert_eq!(error["error"]["code"], "invalid_input");
    }
    application.shutdown().await.unwrap();
}
