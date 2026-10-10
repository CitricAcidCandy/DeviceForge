//! 残余侧车固定白名单及真实假工具四流回归，不连接实际设备。
use super::*;
use crate::artifacts::FileArtifacts;
use apk_domain::artifacts::{ArchivePage, Artifact, ArtifactStream};
use futures_util::{StreamExt, TryStreamExt};
use serde_json::json;
use std::{
    io::{Cursor, Write},
    path::PathBuf,
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::fs::File;
use tokio_util::io::ReaderStream;
use zip::{ZipWriter, write::SimpleFileOptions};

#[derive(Default)]
struct StoreSpy {
    calls: AtomicUsize,
}

impl StoreSpy {
    fn reject<T>(&self) -> Result<T> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(Error::Storage("测试产物端口不应被调用".into()))
    }
}

#[async_trait]
impl ArtifactStore for StoreSpy {
    async fn put(&self, _: String, _: ArtifactStream) -> Result<Artifact> {
        self.reject()
    }
    async fn get(&self, _: &str) -> Result<Artifact> {
        self.reject()
    }
    async fn download(&self, _: &str) -> Result<(Artifact, ArtifactStream)> {
        self.reject()
    }
    async fn archive_entries(&self, _: &str, _: usize, _: usize) -> Result<ArchivePage> {
        self.reject()
    }
}

fn compile(source: &std::path::Path, executable: &std::path::Path) {
    let output = std::process::Command::new("rustc")
        .arg(source)
        .arg("-o")
        .arg(executable)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let executable = directory.path().join(if cfg!(windows) {
                "device-tool.exe"
            } else {
                "device-tool"
            });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/device_artifacts/fixtures/device-tool.rs");
            compile(&source, &executable);
            (directory, executable.to_string_lossy().into_owned())
        })
        .1
}

fn spy_tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join("spy-tool.rs");
            let executable = directory.path().join(if cfg!(windows) {
                "spy-tool.exe"
            } else {
                "spy-tool"
            });
            std::fs::write(
                &source,
                r#"
// 任一工具启动都留证；拒绝入口不能触发此程序。
fn main() {
    let marker = std::env::current_exe().unwrap().parent().unwrap().join("tool-started");
    std::fs::write(marker, b"started").unwrap();
    std::process::exit(9);
}
"#,
            )
            .unwrap();
            compile(&source, &executable);
            (directory, executable.to_string_lossy().into_owned())
        })
        .1
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
            Box::pin(ReaderStream::new(file).map_err(|error| Error::Storage(error.to_string()))),
        )
        .await
        .unwrap()
}

async fn setup() -> (
    tempfile::TempDir,
    Arc<FileArtifacts>,
    RemainingDeviceArtifactActions,
    PathBuf,
) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    let executable = directory.path().join(if cfg!(windows) {
        "device-tool.exe"
    } else {
        "device-tool"
    });
    tokio::fs::copy(tool(), &executable).await.unwrap();
    let path = executable.to_string_lossy().into_owned();
    let actions = RemainingDeviceArtifactActions::new(path.clone(), path, store.clone());
    let marker = directory.path().join("installation-path");
    (directory, store, actions, marker)
}

async fn invoke(
    actions: &RemainingDeviceArtifactActions,
    operation: &str,
    input: Value,
    with_context: bool,
) -> Result<Value> {
    if with_context {
        actions
            .execute_with_context(
                operation,
                input,
                CancellationToken::new(),
                ExecutionContext {
                    deadline: Some(std::time::Instant::now() + std::time::Duration::from_secs(120)),
                },
            )
            .await
    } else {
        actions
            .execute(operation, input, CancellationToken::new())
            .await
    }
}

#[test]
fn declares_exactly_the_four_preserved_contributions() {
    let actions = RemainingDeviceArtifactActions::new(
        "unused".into(),
        "unused".into(),
        Arc::new(StoreSpy::default()),
    );
    assert_eq!(
        actions
            .operations()
            .iter()
            .map(|operation| operation.id.as_str())
            .collect::<Vec<_>>(),
        [
            "android.app.install",
            "android.screenshot",
            "harmony.app.install",
            "harmony.app.uninstall"
        ]
    );
    assert!(matches!(
        actions.result_format(),
        ExecutorResultFormat::Json
    ));
    assert!(!actions.has_unresolved_resources());
}

#[tokio::test]
async fn both_entrypoints_reject_uninstall_before_cancellation_context_or_any_side_effect() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory
        .path()
        .join(if cfg!(windows) { "spy.exe" } else { "spy" });
    tokio::fs::copy(spy_tool(), &executable).await.unwrap();
    let path = executable.to_string_lossy().into_owned();
    let store = Arc::new(StoreSpy::default());
    let actions = RemainingDeviceArtifactActions::new(path.clone(), path, store.clone());
    for operation in [
        "android.app.uninstall",
        "android.app.start",
        "android.input",
        "android.devices",
        "unknown",
        "plugin.android-device.app.uninstall",
    ] {
        for with_context in [false, true] {
            for pre_cancel in [false, true] {
                let cancel = CancellationToken::new();
                if pre_cancel {
                    cancel.cancel();
                }
                let input = json!({"device_id":"ok","package":"com.example.app"});
                let result = if with_context {
                    actions
                        .execute_with_context(
                            operation,
                            input,
                            cancel,
                            ExecutionContext {
                                deadline: Some(
                                    std::time::Instant::now() - std::time::Duration::from_secs(1),
                                ),
                            },
                        )
                        .await
                } else {
                    actions.execute(operation, input, cancel).await
                };
                assert!(matches!(result, Err(Error::NotFound(ref value)) if value == operation));
            }
        }
    }
    assert_eq!(store.calls.load(Ordering::SeqCst), 0);
    assert!(!directory.path().join("tool-started").exists());
}

async fn install_preserves_verified_copy(operation: &str, filename: &str) {
    let (_directory, store, actions, marker) = setup().await;
    let artifact = upload(&store, filename).await;
    for with_context in [false, true] {
        let result = invoke(
            &actions,
            operation,
            json!({"device_id":"ok","artifact_id":artifact.id}),
            with_context,
        )
        .await
        .unwrap();
        assert_eq!(result["artifact_id"], artifact.id);
        let output = result["output"].as_str().unwrap();
        assert!(output.contains(&format!("temporary:{filename}")));
        if operation == "harmony.app.install" {
            assert!(output.ends_with("msg:install bundle successfully."));
        } else {
            assert!(output.lines().any(|line| line == "Success"));
        }
        let private = PathBuf::from(tokio::fs::read_to_string(&marker).await.unwrap());
        assert!(!output.contains(private.to_string_lossy().as_ref()));
        assert!(!private.exists());
        assert!(!private.parent().unwrap().exists());
    }
}

#[tokio::test]
async fn android_apk_install_preserves_the_real_tool_and_artifact_result() {
    install_preserves_verified_copy("android.app.install", "sample.apk").await;
}

#[tokio::test]
async fn harmony_hap_install_preserves_the_real_tool_and_artifact_result() {
    install_preserves_verified_copy("harmony.app.install", "sample.hap").await;
}

#[tokio::test]
async fn harmony_uninstall_preserves_hdc_arguments_and_success_text() {
    let (_directory, _store, actions, _marker) = setup().await;
    for with_context in [false, true] {
        let result = invoke(
            &actions,
            "harmony.app.uninstall",
            json!({"device_id":"ok","package":"com.example.app"}),
            with_context,
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            json!({"output":"[Info]App uninstall path: msg:uninstall bundle successfully."})
        );
    }
}

#[tokio::test]
async fn screenshot_preserves_original_png_bytes_from_the_real_tool() {
    let (_directory, store, actions, _marker) = setup().await;
    for with_context in [false, true] {
        let result = invoke(
            &actions,
            "android.screenshot",
            json!({"device_id":"ok"}),
            with_context,
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
        assert_eq!(bytes, include_bytes!("../fixtures/pixel.png"));
    }
}

#[tokio::test]
async fn preserved_flows_keep_their_stderr_failure_and_invalid_png_boundaries() {
    let (_directory, store, actions, _marker) = setup().await;
    let artifact = upload(&store, "sample.apk").await;
    for with_context in [false, true] {
        assert!(matches!(
            invoke(
                &actions,
                "android.app.install",
                json!({"device_id":"stderr-failure","artifact_id":artifact.id}),
                with_context
            )
            .await,
            Err(Error::Dependency(_))
        ));
        assert!(matches!(
            invoke(
                &actions,
                "harmony.app.uninstall",
                json!({"device_id":"stderr-failure","package":"com.example.app"}),
                with_context
            )
            .await,
            Err(Error::Dependency(_))
        ));
        assert!(matches!(
            invoke(
                &actions,
                "android.screenshot",
                json!({"device_id":"invalid"}),
                with_context
            )
            .await,
            Err(Error::Invalid(_))
        ));
    }
}

#[tokio::test]
async fn allowed_operations_forward_the_original_cancellation_without_io() {
    let store = Arc::new(StoreSpy::default());
    let actions = RemainingDeviceArtifactActions::new(
        "never-start".into(),
        "never-start".into(),
        store.clone(),
    );
    for with_context in [false, true] {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = if with_context {
            actions
                .execute_with_context(
                    "android.app.install",
                    json!({}),
                    cancel,
                    ExecutionContext::default(),
                )
                .await
        } else {
            actions
                .execute("android.app.install", json!({}), cancel)
                .await
        };
        assert!(matches!(result, Err(Error::Cancelled)));
    }
    assert_eq!(store.calls.load(Ordering::SeqCst), 0);
}
