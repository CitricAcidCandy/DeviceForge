use super::*;
use crate::artifacts::FileArtifacts;
use apk_domain::{artifacts::Artifact, splits::DeviceSpec};
use futures_util::StreamExt;
use std::{
    io::{Cursor, Write},
    sync::OnceLock,
};
use zip::{ZipWriter, write::SimpleFileOptions};
fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn tool(mode: &str) -> ToolCommand {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    let (_, executable) = TOOL.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join(if cfg!(windows) {
            "split-tool.exe"
        } else {
            "split-tool"
        });
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/splits/fixtures/bundletool.rs");
        let output = std::process::Command::new("rustc")
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        (directory, executable.to_string_lossy().into_owned())
    });
    ToolCommand {
        executable: executable.clone(),
        prefix: vec![mode.into()],
    }
}
async fn setup(mode: &str) -> (tempfile::TempDir, Arc<AndroidSplits>, Artifact) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    let apk = archive(&[("AndroidManifest.xml", b"manifest")]);
    let bytes = archive(&[("toc.pb", b"toc"), ("splits/base-master.apk", &apk)]);
    let input = store
        .put(
            "test.apks".into(),
            Box::pin(futures_util::stream::iter([Ok(bytes.into())])),
        )
        .await
        .unwrap();
    std::fs::write(directory.path().join("mock-adb"), b"test-only").unwrap();
    let adb = directory
        .path()
        .join("mock-adb")
        .to_string_lossy()
        .into_owned();
    (
        directory,
        Arc::new(AndroidSplits::new(store, Some(tool(mode)), adb)),
        input,
    )
}
fn spec(abi: &str) -> DeviceSpec {
    DeviceSpec {
        supported_abis: vec![abi.into()],
        supported_locales: vec!["en-US".into(), "zh_CN".into()],
        screen_density: 480,
        sdk_version: 35,
    }
}
fn extract(id: &str, abi: &str) -> ExtractSplitsRequest {
    ExtractSplitsRequest {
        artifact_id: id.into(),
        device_spec: spec(abi),
    }
}
fn install(id: &str, device: &str) -> InstallApksRequest {
    InstallApksRequest {
        artifact_id: id.into(),
        device_id: device.into(),
    }
}
#[tokio::test]
async fn extraction_matches_the_typed_spec_and_publishes_one_zip() {
    let (_dir, adapter, input) = setup("ok").await;
    for (abi, count) in [("arm64-v8a", 2), ("x86", 1)] {
        let result = adapter
            .extract(extract(&input.id, abi), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.apk_entries.len(), count);
        assert_eq!(result.source_artifact_id, input.id);
        assert_ne!(result.artifact.id, input.id);
        assert_eq!(result.artifact.filename, "selected-apks.zip");
        let (_, mut stream) = adapter
            .artifacts
            .download(&result.artifact.id)
            .await
            .unwrap();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk.unwrap());
        }
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(zip.len(), count);
        for name in result.apk_entries {
            let member = zip.by_name(&name).unwrap();
            assert!(member.size() > 0);
        }
    }
}
#[tokio::test]
async fn install_uses_explicit_device_and_accepts_silent_tool_success() {
    let (_dir, adapter, input) = setup("ok").await;
    let result = adapter
        .install(
            install(&input.id, "192.168.1.2:5555"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(result.installed);
    assert_eq!(result.artifact_id, input.id);
    assert_eq!(result.device_id, "192.168.1.2:5555");
    assert!(
        PathBuf::from(format!(
            "{}.{}.started",
            resolve_adb(&adapter.adb).unwrap().display(),
            result.device_id.replace(':', "_")
        ))
        .exists()
    );
    assert!(matches!(
        adapter
            .install(install(&input.id, "offline"), CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
}
#[tokio::test]
async fn errors_and_invalid_outputs_never_publish_or_leak_server_paths() {
    for mode in [
        "fail",
        "false-success",
        "bad-apk",
        "extra",
        "missing",
        "large",
    ] {
        let (_dir, adapter, input) = setup(mode).await;
        let error = adapter
            .extract(extract(&input.id, "arm64-v8a"), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("package.apks"));
        if mode == "large" {
            assert!(matches!(error, Error::TooLarge));
        }
        if ["fail", "false-success"].contains(&mode) {
            assert!(matches!(
                adapter
                    .install(install(&input.id, "ok"), CancellationToken::new())
                    .await,
                Err(Error::Dependency(_))
            ));
        }
    }
}
#[tokio::test]
async fn validates_configuration_source_integrity_and_request_before_running() {
    let (_dir, adapter, input) = setup("ok").await;
    assert!(matches!(
        adapter
            .install(install(&input.id, "-s"), CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
    let missing = AndroidSplits::new(adapter.artifacts.clone(), None, "adb".into());
    assert!(matches!(
        missing
            .extract(extract(&input.id, "arm64-v8a"), CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    let malformed = adapter
        .artifacts
        .put(
            "bad.apks".into(),
            Box::pin(futures_util::stream::iter([Ok(archive(&[(
                "entry.txt",
                b"bad",
            )])
            .into())])),
        )
        .await
        .unwrap();
    assert!(matches!(
        adapter
            .install(install(&malformed.id, "ok"), CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        adapter
            .extract(extract(&input.id, "arm64-v8a"), token)
            .await,
        Err(Error::Cancelled)
    ));
}
fn marker(adapter: &AndroidSplits, device: &str) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}.started",
        resolve_adb(&adapter.adb).unwrap().display(),
        device.replace(':', "_")
    ))
}
async fn started(path: PathBuf) -> PathBuf {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(input) = tokio::fs::read_to_string(&path).await {
                return PathBuf::from(input).parent().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn removed(path: PathBuf) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn running_install_cancel_and_drop_cleanup_and_release_the_lock() {
    for drop_future in [false, true] {
        let (_dir, adapter, input) = setup("slow").await;
        let cancel = CancellationToken::new();
        let request = install(&input.id, "running");
        let task = {
            let adapter = adapter.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { adapter.install(request, cancel).await })
        };
        let temporary = started(marker(&adapter, "running")).await;
        if drop_future {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            cancel.cancel();
            assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
        }
        removed(temporary).await;
        let lock = adapter.device_lock("running").unwrap();
        assert!(lock.try_lock().is_ok());
    }
}
#[tokio::test]
async fn waiting_device_lock_is_cancellable_bounded_and_other_devices_can_run() {
    let (_dir, adapter, input) = setup("ok").await;
    let lock = adapter.device_lock("busy").unwrap();
    let guard = lock.lock().await;
    let cancel = CancellationToken::new();
    let task = {
        let adapter = adapter.clone();
        let request = install(&input.id, "busy");
        let cancel = cancel.clone();
        tokio::spawn(async move { adapter.install(request, cancel).await })
    };
    assert!(
        adapter
            .install(install(&input.id, "other"), CancellationToken::new())
            .await
            .unwrap()
            .installed
    );
    assert!(!marker(&adapter, "busy").exists());
    cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    assert!(matches!(
        adapter
            .install_with_timeout(
                install(&input.id, "busy"),
                CancellationToken::new(),
                Duration::from_millis(20)
            )
            .await,
        Err(Error::Timeout)
    ));
    assert!(!marker(&adapter, "busy").exists());
    drop(guard);
    drop(lock);
    let lock = adapter.device_lock("next").unwrap();
    assert_eq!(adapter.devices.lock().unwrap().len(), 1);
    drop(lock);
}
#[tokio::test]
async fn installation_total_deadline_kills_the_running_process() {
    let (_dir, adapter, input) = setup("slow").await;
    let task = {
        let adapter = adapter.clone();
        let request = install(&input.id, "deadline");
        tokio::spawn(async move {
            adapter
                .install_with_timeout(request, CancellationToken::new(), Duration::from_secs(5))
                .await
        })
    };
    let temporary = started(marker(&adapter, "deadline")).await;
    assert!(matches!(task.await.unwrap(), Err(Error::Timeout)));
    removed(temporary).await;
}
#[tokio::test]
async fn extraction_cancels_an_inflight_process_and_cleans_output() {
    let (directory, mut adapter, input) = setup("slow").await;
    let marker = directory.path().join("extraction.started");
    Arc::get_mut(&mut adapter)
        .unwrap()
        .bundletool
        .as_mut()
        .unwrap()
        .prefix[0] = format!("slow={}", marker.display());
    let cancel = CancellationToken::new();
    let task = {
        let adapter = adapter.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            adapter
                .extract(extract(&input.id, "arm64-v8a"), cancel)
                .await
        })
    };
    let temporary = started(marker).await;
    cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    removed(temporary).await;
}
