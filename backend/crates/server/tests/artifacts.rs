use apk_application::{Application, artifacts::ArtifactOperations};
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use std::{
    io::{Cursor, Write},
    sync::Arc,
};
use tower::ServiceExt;
use zip::{ZipWriter, write::SimpleFileOptions};
fn archive() -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("AndroidManifest.xml", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"manifest").unwrap();
    writer.finish().unwrap().into_inner()
}
async fn call(
    router: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    authorized: bool,
    media: &str,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", media);
    if authorized {
        request = request.header("authorization", "Bearer artifacts-test");
    }
    router
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}
async fn json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}
#[tokio::test]
async fn upload_download_preview_and_shared_operations() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(FileArtifacts::open(dir.path()).await.unwrap());
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(ArtifactOperations(artifacts.clone()))],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router_with_artifacts(
        app.clone(),
        "artifacts-test".into(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    let bytes = archive();
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/v1/artifacts?filename=a.apk",
            bytes.clone(),
            false,
            "application/octet-stream"
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = call(
        &router,
        "POST",
        "/api/v1/artifacts?filename=a.apk",
        bytes.clone(),
        true,
        "application/octet-stream",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let metadata = json(response).await;
    let id = metadata["id"].as_str().unwrap();
    let downloaded = call(
        &router,
        "GET",
        &format!("/api/v1/artifacts/{id}/content"),
        vec![],
        true,
        "application/json",
    )
    .await;
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(downloaded.headers()["x-content-type-options"], "nosniff");
    assert!(
        downloaded.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(
        to_bytes(downloaded.into_body(), 1024 * 1024).await.unwrap(),
        bytes
    );
    let page = json(
        call(
            &router,
            "GET",
            &format!("/api/v1/artifacts/{id}/entries?limit=1"),
            vec![],
            true,
            "application/json",
        )
        .await,
    )
    .await;
    assert_eq!(page["entries"][0]["name"], "AndroidManifest.xml");
    let submitted = app
        .submit("artifact.inspect", serde_json::json!({"artifact_id":id}))
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let result = app.get(&submitted.id).unwrap();
            if result.status.is_terminal() {
                assert_eq!(result.result.unwrap()["id"], id);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let deleted = call(
        &router,
        "DELETE",
        &format!("/api/v2/artifacts/{id}"),
        vec![],
        true,
        "application/json",
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(json(deleted).await["data"]["id"], id);
    assert_eq!(
        call(
            &router,
            "GET",
            &format!("/api/v1/artifacts/{id}"),
            vec![],
            true,
            "application/json",
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn upload_limit_and_invalid_requests_return_protocol_errors() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(FileArtifacts::with_limit(dir.path(), 128).await.unwrap());
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router_with_artifacts(
        app.clone(),
        "artifacts-test".into(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    for (path, body, media, status) in [
        (
            "/api/v1/artifacts?filename=a.apk",
            vec![0; 129],
            "application/octet-stream",
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "/api/v1/artifacts?filename=..%2Fa.apk",
            vec![],
            "application/octet-stream",
            StatusCode::BAD_REQUEST,
        ),
        (
            "/api/v1/artifacts?filename=a.apk",
            vec![],
            "application/json",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "/api/v1/artifacts",
            vec![],
            "application/octet-stream",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = call(&router, "POST", path, body, true, media).await;
        assert_eq!(response.status(), status);
        assert!(json(response).await["code"].is_string());
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn binary_upload_above_json_limit_and_mcp_metadata_tool() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::with_limit(dir.path(), 1024 * 1024)
            .await
            .unwrap(),
    );
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(ArtifactOperations(artifacts.clone()))],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router_with_artifacts(
        app.clone(),
        "artifacts-test".into(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "payload.bin",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    writer.write_all(&vec![7; 300 * 1024]).unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let response = call(
        &router,
        "POST",
        "/api/v1/artifacts?filename=large.zip",
        bytes,
        true,
        "application/octet-stream",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let metadata = json(response).await;
    let id = metadata["id"].as_str().unwrap();
    let request = Request::builder().method("POST").uri("/mcp")
        .header("host","127.0.0.1:7031").header("authorization","Bearer artifacts-test")
        .header("content-type","application/json").header("accept","application/json, text/event-stream")
        .header("MCP-Protocol-Version","2026-07-28").header("Mcp-Method","tools/call").header("Mcp-Name","artifact.inspect")
        .body(Body::from(serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call","params":{
                "name":"artifact.inspect","arguments":{"artifact_id":id},"_meta":{
                    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                    "io.modelcontextprotocol/clientInfo":{"name":"artifact-contract","version":"1"},
                    "io.modelcontextprotocol/clientCapabilities":{}
                }
            }
        }).to_string())).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result = json(response).await;
    assert_eq!(result["result"]["isError"], false);
    let job_id = result["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap();
    assert_eq!(app.get(job_id).unwrap().input["artifact_id"], id);
    app.shutdown().await.unwrap();
}
