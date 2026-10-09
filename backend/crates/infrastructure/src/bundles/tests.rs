use super::*;
use crate::{artifacts::FileArtifacts, package_tools::AndroidPackageTools};
use apk_domain::{artifacts::Artifact, bundles::BuildMode, packages::PackageAnalyzer};
use futures_util::StreamExt;
use std::{
    io::{Cursor, Write},
    sync::OnceLock,
};
use zip::{ZipWriter, write::SimpleFileOptions};
fn tool(mode: &str) -> ToolCommand {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    let (_, executable) = TOOL.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join(if cfg!(windows) {
            "bundletool.exe"
        } else {
            "bundletool"
        });
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bundles/fixtures/bundletool.rs");
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
fn apk() -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("AndroidManifest.xml", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"manifest").unwrap();
    zip.finish().unwrap().into_inner()
}
async fn setup(mode: &str) -> (tempfile::TempDir, AndroidBundles, Artifact) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    let path = directory.path().join("测试 密钥.jks");
    tokio::fs::write(&path, b"test-only").await.unwrap();
    let signing = BundleSigning {
        keystore: path.clone(),
        alias: "测试别名".into(),
        store_password_file: path.clone(),
        key_password_file: path,
    };
    let input = store
        .put(
            "test.aab".into(),
            Box::pin(futures_util::stream::iter([Ok(apk().into())])),
        )
        .await
        .unwrap();
    (
        directory,
        AndroidBundles {
            artifacts: store,
            bundletool: Some(tool(mode)),
            signing: Some(signing),
        },
        input,
    )
}
fn request(id: &str, mode: BuildMode) -> BuildApksRequest {
    BuildApksRequest {
        artifact_id: id.into(),
        mode,
    }
}

#[tokio::test]
async fn builds_both_modes_and_universal_can_be_extracted_again() {
    let (_dir, builder, input) = setup("ok").await;
    for mode in [BuildMode::Default, BuildMode::Universal] {
        let result = builder
            .build(request(&input.id, mode), CancellationToken::new())
            .await
            .unwrap();
        assert_ne!(result.artifact.id, input.id);
        assert_eq!(result.mode, mode);
        assert_eq!(
            result.apk_count,
            if mode == BuildMode::Universal { 1 } else { 2 }
        );
        assert_eq!(
            result.universal_entry.as_deref(),
            (mode == BuildMode::Universal).then_some("universal.apk")
        );
        assert_eq!(result.artifact.filename, "built.apks");
        if mode == BuildMode::Universal {
            let analyzer = AndroidPackageTools {
                artifacts: builder.artifacts.clone(),
                apkanalyzer: tool("unused"),
                apksigner: tool("unused"),
                bundletool: None,
            };
            let extracted = analyzer
                .extract_apk(
                    &result.artifact.id,
                    "universal.apk",
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let (_, mut stream) = builder
                .artifacts
                .download(&extracted.artifact.id)
                .await
                .unwrap();
            let mut actual = Vec::new();
            while let Some(chunk) = stream.next().await {
                actual.extend_from_slice(&chunk.unwrap());
            }
            assert_eq!(actual, apk());
        }
    }
}
#[tokio::test]
async fn rejects_bad_outputs_and_redacts_tool_diagnostics() {
    for mode in [
        "bad-toc",
        "bad-apk",
        "duplicate",
        "traversal",
        "crc",
        "missing",
        "fail",
        "large",
    ] {
        let (_dir, builder, input) = setup(mode).await;
        let error = builder
            .build(
                request(&input.id, BuildMode::Universal),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(!message.contains("测试 密钥"));
        assert!(!message.contains("--ks"));
        if mode == "large" {
            assert!(matches!(error, Error::TooLarge));
        }
        if mode == "fail" {
            assert!(matches!(error, Error::Dependency(_)));
        }
    }
}
#[tokio::test]
async fn deployment_and_input_are_required_before_tool_execution() {
    let (_dir, mut builder, input) = setup("fail").await;
    let signed = builder.signing.take();
    assert!(matches!(
        builder
            .build(
                request(&input.id, BuildMode::Default),
                CancellationToken::new()
            )
            .await,
        Err(Error::Dependency(_))
    ));
    builder.signing = signed;
    builder.bundletool = None;
    assert!(matches!(
        builder
            .build(
                request(&input.id, BuildMode::Default),
                CancellationToken::new()
            )
            .await,
        Err(Error::Dependency(_))
    ));
    builder.bundletool = Some(tool("fail"));
    builder.signing.as_mut().unwrap().keystore = PathBuf::from("relative.jks");
    assert!(matches!(
        builder
            .build(
                request(&input.id, BuildMode::Default),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        builder
            .build(
                request("not-an-id", BuildMode::Default),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    builder.signing.as_mut().unwrap().keystore = builder
        .signing
        .as_ref()
        .unwrap()
        .store_password_file
        .clone();
    let other = builder
        .artifacts
        .put(
            "test.apk".into(),
            Box::pin(futures_util::stream::iter([Ok(apk().into())])),
        )
        .await
        .unwrap();
    assert!(matches!(
        builder
            .build(
                request(&other.id, BuildMode::Default),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
}
async fn started(builder: &AndroidBundles) -> PathBuf {
    let marker = PathBuf::from(format!(
        "{}.started",
        builder.signing.as_ref().unwrap().keystore.display()
    ));
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(path) = tokio::fs::read_to_string(&marker).await {
                return PathBuf::from(path).parent().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn removed(path: PathBuf) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn running_cancel_and_dropped_future_remove_temporary_files() {
    for drop_future in [false, true] {
        let (_dir, builder, input) = setup("slow").await;
        let builder = Arc::new(builder);
        let cancel = CancellationToken::new();
        let task = {
            let builder = builder.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                builder
                    .build(request(&input.id, BuildMode::Universal), cancel)
                    .await
            })
        };
        let temporary = started(&builder).await;
        if drop_future {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            cancel.cancel();
            assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
        }
        removed(temporary).await;
    }
}
#[tokio::test]
async fn total_deadline_stops_the_real_tool() {
    let (_dir, builder, input) = setup("slow").await;
    let builder = Arc::new(builder);
    let task = {
        let builder = builder.clone();
        tokio::spawn(async move {
            builder
                .build_with_timeout(
                    request(&input.id, BuildMode::Default),
                    CancellationToken::new(),
                    Duration::from_secs(5),
                )
                .await
        })
    };
    let temporary = started(&builder).await;
    assert!(matches!(task.await.unwrap(), Err(Error::Timeout)));
    removed(temporary).await;
}
