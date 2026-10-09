use super::*;
use crate::artifacts::FileArtifacts;
use apk_domain::artifacts::Artifact;
use futures_util::StreamExt;
use std::{
    io::{Cursor, Write},
    path::PathBuf,
    sync::OnceLock,
};
use zip::{ZipWriter, write::SimpleFileOptions};

fn tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(if cfg!(windows) {
                "device-tool.exe"
            } else {
                "device-tool"
            });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/device_artifacts/fixtures/device-tool.rs");
            let output = std::process::Command::new("rustc")
                .arg(source)
                .arg("-o")
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (directory, path.to_string_lossy().into_owned())
        })
        .1
}
async fn setup() -> (tempfile::TempDir, Arc<FileArtifacts>, DeviceArtifactActions) {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let actions = DeviceArtifactActions {
        adb: tool().into(),
        hdc: tool().into(),
        artifacts: artifacts.clone(),
    };
    (directory, artifacts, actions)
}
async fn upload(store: &FileArtifacts, filename: &str) -> Artifact {
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"{}").unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let source = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(source.path(), bytes).await.unwrap();
    let file = File::open(source.path()).await.unwrap();
    store
        .put(
            filename.into(),
            Box::pin(ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()))),
        )
        .await
        .unwrap()
}
#[test]
fn package_and_success_validation() {
    for name in ["com.example.app", "com.example_1.app"] {
        assert!(package(name).is_ok());
    }
    for name in [
        "com..app",
        "app",
        "com.1app",
        "com.app:evil",
        "com.app[evil]",
        "com.app;reboot",
    ] {
        assert!(package(name).is_err());
    }
    assert!(success("Success", false, true).is_ok());
    assert!(success("Success\nFailure", false, true).is_err());
    assert!(success("Success-ish", false, true).is_err());
    assert!(
        success(
            "[Info]App install path:x msg:install bundle successfully.\nAppMod finish.",
            true,
            true
        )
        .is_ok()
    );
    assert!(success("msg:install bundle successfully.", true, false).is_err());
}
#[tokio::test]
async fn installations_use_verified_artifacts_and_remove_temporary_files() {
    let (_directory, store, mut actions) = setup().await;
    let tool_directory = tempfile::tempdir().unwrap();
    let executable = tool_directory
        .path()
        .join(if cfg!(windows) { "tool.exe" } else { "tool" });
    tokio::fs::copy(tool(), &executable).await.unwrap();
    actions.adb = executable.to_string_lossy().into_owned();
    actions.hdc = actions.adb.clone();
    for (operation, filename) in [
        ("android.app.install", "sample.apk"),
        ("harmony.app.install", "sample.hap"),
    ] {
        let artifact = upload(&store, filename).await;
        let result = actions
            .execute(
                operation,
                json!({"device_id":"ok", "artifact_id":artifact.id}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["artifact_id"], artifact.id);
        assert!(
            result["output"]
                .as_str()
                .unwrap()
                .contains(&format!("temporary:{filename}"))
        );
        let path = PathBuf::from(
            tokio::fs::read_to_string(tool_directory.path().join("installation-path"))
                .await
                .unwrap(),
        );
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }
    let artifact = upload(&store, "unsupported.aab").await;
    assert!(matches!(
        actions
            .execute(
                "android.app.install",
                json!({"device_id":"ok", "artifact_id":artifact.id}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn corruption_prevents_installation() {
    let (directory, store, actions) = setup().await;
    let artifact = upload(&store, "sample.apk").await;
    let path = directory.path().join(&artifact.id).join("content");
    let mut bytes = tokio::fs::read(&path).await.unwrap();
    bytes[0] ^= 1;
    tokio::fs::write(path, bytes).await.unwrap();
    assert!(matches!(
        actions
            .execute(
                "android.app.install",
                json!({"device_id":"ok", "artifact_id":artifact.id}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Storage(_))
    ));
}
#[tokio::test]
async fn tool_failures_and_uninstall_arguments_are_observed() {
    let (_directory, store, actions) = setup().await;
    let artifact = upload(&store, "sample.apk").await;
    for mode in ["failure", "stderr-failure", "silent", "exit"] {
        assert!(matches!(
            actions
                .execute(
                    "android.app.install",
                    json!({"device_id":mode, "artifact_id":artifact.id}),
                    CancellationToken::new()
                )
                .await,
            Err(Error::Dependency(_))
        ));
    }
    for operation in ["android.app.uninstall", "harmony.app.uninstall"] {
        actions
            .execute(
                operation,
                json!({"device_id":"ok","package":"com.example.app"}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    assert!(matches!(
        actions
            .execute(
                "android.app.uninstall",
                json!({"device_id":"ok","package":"com.app:evil"}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn screenshot_preserves_binary_and_rejects_invalid_content() {
    let (_directory, store, actions) = setup().await;
    let result = actions
        .execute(
            "android.screenshot",
            json!({"device_id":"ok"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["filename"], "screenshot.png");
    let (_, mut stream) = store
        .download(result["id"].as_str().unwrap())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(bytes, include_bytes!("fixtures/pixel.png"));
    assert!(matches!(
        actions
            .execute(
                "android.screenshot",
                json!({"device_id":"invalid"}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        actions
            .execute(
                "android.screenshot",
                json!({"device_id":"exit"}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Dependency(_))
    ));
}
#[tokio::test]
async fn binary_process_limit_timeout_and_running_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("output");
    let mut file = File::create(&path).await.unwrap();
    let args = |mode: &str| {
        vec![
            "-s".into(),
            mode.into(),
            "exec-out".into(),
            "screencap".into(),
            "-p".into(),
        ]
    };
    assert!(matches!(
        process::run_to_file(
            tool(),
            &args("large"),
            &mut file,
            1024,
            Duration::from_secs(5),
            CancellationToken::new()
        )
        .await,
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        process::run_to_file(
            tool(),
            &args("sleep"),
            &mut file,
            LIMIT,
            Duration::from_millis(50),
            CancellationToken::new()
        )
        .await,
        Err(Error::Timeout)
    ));
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        trigger.cancel();
    });
    assert!(matches!(
        process::run_to_file(
            tool(),
            &args("sleep"),
            &mut file,
            LIMIT,
            Duration::from_secs(5),
            cancel
        )
        .await,
        Err(Error::Cancelled)
    ));
    drop(file);
    tokio::fs::remove_file(path).await.unwrap();
}
#[tokio::test]
async fn text_process_timeout_and_running_cancellation() {
    let args = vec![
        "-s".into(),
        "sleep".into(),
        "uninstall".into(),
        "com.example.app".into(),
    ];
    assert!(matches!(
        process::run_text(
            tool(),
            &args,
            Duration::from_millis(50),
            CancellationToken::new()
        )
        .await,
        Err(Error::Timeout)
    ));
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        trigger.cancel();
    });
    assert!(matches!(
        process::run_text(tool(), &args, Duration::from_secs(5), cancel).await,
        Err(Error::Cancelled)
    ));
}
#[tokio::test]
async fn dropped_execution_cleans_tool_held_temporary_directory() {
    let (_directory, store, mut actions) = setup().await;
    let artifact = upload(&store, "sample.apk").await;
    let tool_directory = tempfile::tempdir().unwrap();
    let executable = tool_directory
        .path()
        .join(if cfg!(windows) { "tool.exe" } else { "tool" });
    tokio::fs::copy(tool(), &executable).await.unwrap();
    actions.adb = executable.to_string_lossy().into_owned();
    let marker = tool_directory.path().join("installation-path");
    let task = tokio::spawn(async move {
        actions
            .execute(
                "android.app.install",
                json!({"device_id":"sleep-install","artifact_id":artifact.id}),
                CancellationToken::new(),
            )
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(tokio::time::Instant::now() < deadline, "工具应在期限内启动");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let path = PathBuf::from(tokio::fs::read_to_string(marker).await.unwrap());
    assert!(path.exists());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    while path.parent().unwrap().exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "取消执行后应清理临时目录"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
