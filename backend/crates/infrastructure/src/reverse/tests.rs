use super::*;
use crate::artifacts::FileArtifacts;
use apk_domain::artifacts::Artifact;
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
            let path = directory
                .path()
                .join(if cfg!(windows) { "tool.exe" } else { "tool" });
            let source =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/reverse/fixtures/apktool.rs");
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
fn command(mode: &str) -> ToolCommand {
    ToolCommand {
        executable: tool().into(),
        prefix: vec![mode.into()],
    }
}
async fn upload(store: &FileArtifacts, filename: &str, entries: &[(&str, &[u8])]) -> Artifact {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    let source = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(source.path(), zip.finish().unwrap().into_inner())
        .await
        .unwrap();
    let file = tokio::fs::File::open(source.path()).await.unwrap();
    store
        .put(
            filename.into(),
            Box::pin(ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()))),
        )
        .await
        .unwrap()
}
async fn setup(
    mode: &str,
) -> (
    tempfile::TempDir,
    Arc<FileArtifacts>,
    AndroidReverse,
    Artifact,
) {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let apk = upload(
        &artifacts,
        "app.apk",
        &[("AndroidManifest.xml", b"fixture")],
    )
    .await;
    let adapter = AndroidReverse {
        artifacts: artifacts.clone(),
        apktool: Some(command(mode)),
    };
    (directory, artifacts, adapter, apk)
}
fn rule(name: &str, path: &str, class: Option<&str>) -> SdkRule {
    SdkRule {
        name: name.into(),
        package_path: path.into(),
        class_name: class.map(str::to_owned),
    }
}
#[tokio::test]
async fn decode_publish_and_multidex_scan_share_artifacts() {
    let (_directory, store, adapter, apk) = setup("ok").await;
    let decoded = adapter
        .decode(&apk.id, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(decoded.source_artifact_id, apk.id);
    assert_eq!(decoded.artifact.filename, "decoded.zip");
    assert_eq!(decoded.files, 3);
    let entries = store
        .archive_entries(&decoded.artifact.id, 0, 20)
        .await
        .unwrap();
    assert!(
        entries
            .entries
            .iter()
            .any(|entry| entry.name == "smali_classes2/com/example/sdk/Entry$Inner.smali")
    );
    let result = adapter
        .scan_sdks(
            &decoded.artifact.id,
            vec![
                rule("存在", "com.example.sdk", Some("Entry$Inner")),
                rule("缺失类", "com.example.sdk", Some("Missing")),
                rule("边界", "com.example.sd", None),
            ],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(result.findings[0].package_found);
    assert_eq!(result.findings[0].class_found, Some(true));
    assert_eq!(
        result.findings[0].evidence,
        ["smali_classes2/com/example/sdk/Entry$Inner.smali"]
    );
    assert_eq!(result.findings[1].class_found, Some(false));
    assert!(result.findings[1].package_found);
    assert!(!result.findings[2].package_found);
    assert_eq!(result.findings[2].class_found, None);
}
#[tokio::test]
async fn process_failures_limits_cancellation_and_missing_configuration() {
    let (_directory, _store, mut adapter, apk) = setup("exit").await;
    assert!(matches!(
        adapter.decode(&apk.id, CancellationToken::new()).await,
        Err(Error::Dependency(_))
    ));
    adapter.apktool = Some(command("silent"));
    assert!(
        adapter
            .decode(&apk.id, CancellationToken::new())
            .await
            .is_err()
    );
    adapter.apktool = Some(command("large"));
    assert!(matches!(
        adapter.decode(&apk.id, CancellationToken::new()).await,
        Err(Error::TooLarge)
    ));
    adapter.apktool = Some(command("slow"));
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
    });
    assert!(matches!(
        adapter.decode(&apk.id, cancel).await,
        Err(Error::Cancelled)
    ));
    adapter.apktool = None;
    assert!(matches!(
        adapter.decode(&apk.id, CancellationToken::new()).await,
        Err(Error::Dependency(_))
    ));
}
#[test]
fn sdk_rules_reject_ambiguous_names_and_server_paths() {
    for rules in [
        vec![],
        vec![rule("SDK", "../path", None)],
        vec![rule("SDK", "com.example", Some("a/b"))],
        vec![rule("SDK", "com..example", None)],
        vec![
            rule("重复", "com.example", None),
            rule("重复", "com.other", None),
        ],
    ] {
        assert!(scanning::validate(&rules).is_err());
    }
    assert!(scanning::validate(&vec![rule("SDK", "com.example", None); 101]).is_err());
    assert!(scanning::validate(&[rule("SDK", "com._example", Some("$Entry"))]).is_ok());
    assert!(scanning::validate(&[rule("SDK", "com.example_sdk", Some("Entry$Inner"))]).is_ok());
}
#[tokio::test]
async fn scan_requires_decoded_container_and_ignores_fake_smali_roots() {
    let (_directory, store, adapter, _apk) = setup("ok").await;
    let archive = upload(
        &store,
        "fake.zip",
        &[("smali_fake/com/example/A.smali", b"class")],
    )
    .await;
    assert!(matches!(
        adapter
            .scan_sdks(
                &archive.id,
                vec![rule("SDK", "com.example", None)],
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    let archive = upload(
        &store,
        "fake.zip",
        &[
            ("apktool.yml", b"fixture"),
            ("AndroidManifest.xml", b"fixture"),
            ("smali_classes1/com/example/A.smali", b"class"),
            ("smali_fake/com/example/A.smali", b"class"),
        ],
    )
    .await;
    let scan = adapter
        .scan_sdks(
            &archive.id,
            vec![rule("SDK", "com.example", None)],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!scan.findings[0].package_found);
}
#[test]
fn packing_requires_outputs_and_refuses_oversized_trees() {
    let directory = tempfile::tempdir().unwrap();
    let token = CancellationToken::new();
    assert!(packing::pack(directory.path(), &directory.path().join("out.zip"), &token).is_err());
    std::fs::File::create(directory.path().join("large"))
        .unwrap()
        .set_len(65 * 1024 * 1024)
        .unwrap();
    assert!(matches!(
        packing::check(directory.path(), &token),
        Err(Error::TooLarge)
    ));
    token.cancel();
    assert!(matches!(
        packing::check(directory.path(), &token),
        Err(Error::Cancelled)
    ));
}
#[tokio::test]
async fn sdk_evidence_is_bounded_and_keeps_the_selected_class() {
    let (_directory, store, adapter, _apk) = setup("ok").await;
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("apktool.yml".into(), b"fixture".to_vec()),
        ("AndroidManifest.xml".into(), b"fixture".to_vec()),
    ];
    for index in 0..15 {
        entries.push((
            format!("smali/com/example/A{index:02}.smali"),
            b"class".to_vec(),
        ));
    }
    entries.push((
        "smali_classes2/com/example/Z.smali".into(),
        b"class".to_vec(),
    ));
    let borrowed: Vec<_> = entries
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
        .collect();
    let artifact = upload(&store, "decoded.zip", &borrowed).await;
    let result = adapter
        .scan_sdks(
            &artifact.id,
            vec![rule("SDK", "com.example", Some("Z"))],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.findings[0].evidence.len(), 10);
    assert_eq!(result.findings[0].class_found, Some(true));
    assert!(
        result.findings[0]
            .evidence
            .iter()
            .any(|path| path == "smali_classes2/com/example/Z.smali")
    );
}
#[cfg(unix)]
#[test]
fn packing_rejects_output_links() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("linked")).unwrap();
    assert!(matches!(
        packing::check(directory.path(), &CancellationToken::new()),
        Err(Error::Invalid(_))
    ));
}
