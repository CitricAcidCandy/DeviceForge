use apk_application::Application;
use apk_domain::{Error, artifacts::ArtifactStore};
use apk_infrastructure::{artifacts::FileArtifacts, store::SqliteStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::time::sleep;
use tower::ServiceExt;

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
        "artifact-coordination".into(),
        100,
        apk_server::mcp::default_config(),
        artifacts,
    )
    .unwrap();
    (app, router)
}

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
                .header("authorization", "Bearer artifact-coordination")
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

async fn upload(router: &Router, filename: &str, body: Vec<u8>) -> axum::response::Response {
    call(
        router,
        "POST",
        &format!("/api/v1/artifacts?filename={filename}"),
        body,
    )
    .await
}

fn server_command(data: &Path) -> Command {
    let binary = std::env::var("CARGO_BIN_EXE_apk-server")
        .expect("集成测试必须由 Cargo 提供 apk-server 可执行文件");
    let plugin_directory = data.join("plugins");
    let mut command = Command::new(binary);
    for (key, value) in std::env::vars() {
        if !key.starts_with("APK_") && key != "DEVICEFORGE_NODE" {
            command.env(key, value);
        }
    }
    command
        .env("APK_DATA_DIR", data)
        .env("APK_PLUGIN_DIR", plugin_directory)
        .env("APK_BIND", "127.0.0.1:0")
        .env_remove("APK_API_TOKEN")
        .env_remove("APK_ARTIFACT_MAX_SIZE")
        .env_remove("APK_ARTIFACT_MAX_TOTAL_BYTES")
        .env_remove("APK_ARTIFACT_RETENTION_SECONDS")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

fn stop_child(child: &mut Child) {
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

async fn wait_for_artifact_lock(child: &mut Child, root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last_error = None;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("apk-server 未取得产物锁便退出：{status:?}");
        }
        match FileArtifacts::open(root).await {
            Err(Error::Conflict(message)) => {
                assert!(message.contains("另一个服务实例"));
                return;
            }
            Ok(store) => drop(store),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("等待 apk-server 产物锁超时：{last_error:?}");
}

#[tokio::test]
async fn real_server_instances_compete_for_one_artifact_directory_lock() {
    let data = tempfile::tempdir().unwrap();
    let artifact_root = data.path().join("artifacts");
    let mut first = server_command(data.path()).spawn().unwrap();
    wait_for_artifact_lock(&mut first, &artifact_root).await;

    let mut second = server_command(data.path()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let second_status = loop {
        if let Some(status) = second.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "第二个 apk-server 未因产物锁退出"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert!(!second_status.success());
    stop_child(&mut first);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match FileArtifacts::open(&artifact_root).await {
            Ok(store) => {
                drop(store);
                break;
            }
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "首个 apk-server 退出后产物锁未释放：{error}"
                );
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

#[tokio::test]
async fn server_router_rebuilds_quota_after_corruption_and_runs_expiration_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::with_limits(directory.path(), 4, 4, None)
            .await
            .unwrap(),
    );
    let (app, router) = service(artifacts).await;
    let uploaded = upload(&router, "original.bin", vec![1; 4]).await;
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    let metadata = json(uploaded).await;
    let id = metadata["id"].as_str().unwrap().to_owned();
    app.shutdown().await.unwrap();
    drop(router);

    tokio::fs::write(directory.path().join(&id).join("content"), [9_u8; 4])
        .await
        .unwrap();
    let reopened = Arc::new(
        FileArtifacts::with_limits(directory.path(), 4, 4, None)
            .await
            .unwrap(),
    );
    assert!(matches!(
        reopened.get(&id).await,
        Err(Error::Storage(message)) if message == "产物内容摘要不匹配"
    ));
    let (app, router) = service(reopened).await;
    assert_eq!(
        upload(&router, "replacement.bin", vec![2; 1])
            .await
            .status(),
        StatusCode::CREATED
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
    let expired = json(upload(&router, "expired.bin", vec![3; 4]).await).await;
    let expired_id = expired["id"].as_str().unwrap().to_owned();
    app.shutdown().await.unwrap();
    drop(router);

    let metadata_path = retention_directory
        .path()
        .join(&expired_id)
        .join("metadata.json");
    let mut metadata: Value =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    metadata["created_at"] = json!(0_u64);
    tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .await
        .unwrap();

    let reopened = Arc::new(
        FileArtifacts::with_limits(retention_directory.path(), 32, 64, Some(1))
            .await
            .unwrap(),
    );
    assert!(!retention_directory.path().join(&expired_id).exists());
    let (app, router) = service(reopened).await;
    assert_eq!(
        upload(&router, "after-retention.bin", vec![4; 4])
            .await
            .status(),
        StatusCode::CREATED
    );
    app.shutdown().await.unwrap();
}
