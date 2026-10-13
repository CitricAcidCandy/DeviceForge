use apk_application::Application;
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use std::{path::Path, sync::Arc};
use tower::ServiceExt;

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer artifacts-quota")
                .header("content-type", "application/octet-stream")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

async fn service(artifacts: Arc<FileArtifacts>) -> (Arc<Application>, Router) {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        Vec::new(),
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router_with_artifacts(
        app.clone(),
        "artifacts-quota".into(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    (app, router)
}

async fn upload(router: &Router, filename: &str, body: Vec<u8>) -> axum::response::Response {
    call(
        router,
        "POST",
        &format!("/api/v1/artifacts?filename={filename}"),
        body,
    )
    .await
}

#[tokio::test]
async fn http_upload_rejects_total_quota_with_stable_error() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::with_limits(directory.path(), 8, 8, None)
            .await
            .unwrap(),
    );
    let (app, router) = service(artifacts).await;
    assert_eq!(
        upload(&router, "first.bin", vec![1; 8]).await.status(),
        StatusCode::CREATED
    );
    let response = upload(&router, "second.bin", vec![2; 1]).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let error = json(response).await;
    assert_eq!(error["code"], "payload_too_large");
    assert_eq!(error["message"], "产物大小超过上限");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn http_delete_releases_total_quota_for_next_upload() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::with_limits(directory.path(), 8, 8, None)
            .await
            .unwrap(),
    );
    let (app, router) = service(artifacts).await;
    let first = json(upload(&router, "first.bin", vec![1; 8]).await).await;
    let id = first["id"].as_str().unwrap();
    assert_eq!(
        upload(&router, "blocked.bin", vec![2; 1]).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let deleted = call(
        &router,
        "DELETE",
        &format!("/api/v2/artifacts/{id}"),
        Vec::new(),
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(json(deleted).await["data"]["id"], id);
    assert_eq!(
        upload(&router, "replacement.bin", vec![3; 1])
            .await
            .status(),
        StatusCode::CREATED
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_rebuilds_quota_and_runs_expiration_maintenance() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::with_limits(directory.path(), 8, 8, None)
            .await
            .unwrap(),
    );
    let (app, router) = service(artifacts).await;
    assert_eq!(
        upload(&router, "persisted.bin", vec![4; 8]).await.status(),
        StatusCode::CREATED
    );
    app.shutdown().await.unwrap();
    drop(router);

    let reopened = Arc::new(
        FileArtifacts::with_limits(directory.path(), 8, 8, None)
            .await
            .unwrap(),
    );
    let (app, router) = service(reopened).await;
    assert_eq!(
        upload(&router, "after-restart.bin", vec![5; 1])
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    app.shutdown().await.unwrap();
    drop(router);

    let retention_directory = tempfile::tempdir().unwrap();
    let initial = Arc::new(
        FileArtifacts::with_limits(retention_directory.path(), 32, 64, Some(1))
            .await
            .unwrap(),
    );
    let (app, router) = service(initial).await;
    let expired = json(upload(&router, "expired.bin", vec![6; 4]).await).await;
    let expired_id = expired["id"].as_str().unwrap().to_owned();
    app.shutdown().await.unwrap();
    drop(router);

    let metadata_path = retention_directory
        .path()
        .join(&expired_id)
        .join("metadata.json");
    let mut metadata: Value =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    metadata["created_at"] = Value::from(0_u64);
    tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();

    let reopened = Arc::new(
        FileArtifacts::with_limits(retention_directory.path(), 32, 64, Some(1))
            .await
            .unwrap(),
    );
    assert!(!Path::new(&retention_directory.path().join(&expired_id)).exists());
    let (app, router) = service(reopened).await;
    assert_eq!(
        upload(&router, "after-retention.bin", vec![7; 4])
            .await
            .status(),
        StatusCode::CREATED
    );
    app.shutdown().await.unwrap();
}
