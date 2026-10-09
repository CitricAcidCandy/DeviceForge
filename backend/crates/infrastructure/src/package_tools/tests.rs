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
            let executable = directory.path().join(if cfg!(windows) {
                "package-tool.exe"
            } else {
                "package-tool"
            });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/package_tools/fixtures/package-tool.rs");
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
        })
        .1
}
fn command(mode: &str) -> ToolCommand {
    ToolCommand {
        executable: tool().into(),
        prefix: vec![mode.into()],
    }
}
async fn setup() -> (tempfile::TempDir, Arc<FileArtifacts>, AndroidPackageTools) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(FileArtifacts::open(directory.path()).await.unwrap());
    let analyzer = AndroidPackageTools {
        artifacts: store.clone(),
        apkanalyzer: command("manifest"),
        apksigner: command("signature"),
        bundletool: Some(command("bundle")),
    };
    (directory, store, analyzer)
}
fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
async fn upload(store: &FileArtifacts, filename: &str, bytes: Vec<u8>) -> Artifact {
    let file = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(file.path(), bytes).await.unwrap();
    let reader = tokio::fs::File::open(file.path()).await.unwrap();
    store
        .put(
            filename.into(),
            Box::pin(ReaderStream::new(reader).map_err(|e| Error::Storage(e.to_string()))),
        )
        .await
        .unwrap()
}
#[test]
fn namespace_aware_manifest_and_entities() {
    let result = manifest::parse(
        "sample",
        PackageFormat::Apk,
        None,
        include_str!("fixtures/manifest.xml").into(),
    )
    .unwrap();
    assert_eq!(result.package_name, "com.example.app");
    assert_eq!(result.version_code.as_deref(), Some("42"));
    assert_eq!(result.version_name.as_deref(), Some("1 & 2"));
    assert_eq!(result.min_sdk.as_deref(), Some("23"));
    assert_eq!(result.target_sdk.as_deref(), Some("35"));
    assert_eq!(
        result.application_label.as_deref(),
        Some("@string/app_name")
    );
    assert_eq!(result.debuggable, Some(false));
    assert_eq!(result.permissions, ["android.permission.INTERNET"]);
    let fake = "<manifest xmlns:a='urn:other' package='com.example.app' a:versionCode='99'><application a:debuggable='true'/></manifest>";
    let result = manifest::parse("sample", PackageFormat::Apk, None, fake.into()).unwrap();
    assert!(result.version_code.is_none());
    assert!(result.debuggable.is_none());
}
#[test]
fn malformed_ambiguous_and_unbounded_manifests_are_rejected() {
    for xml in [
        "",
        "<manifest package='com.example.app'>",
        "<other/>",
        "<manifest/>",
        "<manifest package='a'/><manifest package='b'/>",
        "<!DOCTYPE manifest [<!ENTITY x SYSTEM 'file:///secret'>]><manifest package='&x;'/>",
        "<manifest package='a'><application/><application/></manifest>",
        "<manifest package='a'><uses-sdk/><uses-sdk/></manifest>",
        "<manifest package='a' xmlns:a='http://schemas.android.com/apk/res/android'><application a:debuggable='maybe'/></manifest>",
        "<manifest package='a' xmlns:a='http://schemas.android.com/apk/res/android' xmlns:b='http://schemas.android.com/apk/res/android' a:versionCode='1' b:versionCode='2'/>",
        "<manifest package='a' unknown:version='1'/>",
        "<manifest package='a'>text</manifest>",
    ] {
        assert!(
            manifest::parse("id", PackageFormat::Apk, None, xml.into()).is_err(),
            "应拒绝：{xml}"
        );
    }
    let deep = format!(
        "<manifest package='a'>{}{}</manifest>",
        "<node>".repeat(128),
        "</node>".repeat(128)
    );
    assert!(matches!(
        manifest::parse("id", PackageFormat::Apk, None, deep),
        Err(Error::TooLarge)
    ));
}
#[test]
fn complete_signature_report_is_required() {
    let report = include_str!("fixtures/signature.txt");
    let result = signature::parse("id", report.into()).unwrap();
    assert!(result.verified);
    assert_eq!(result.signers[0].certificate_sha256, "ab".repeat(32));
    assert_eq!(result.signers[0].number, 1);
    assert!(
        result
            .schemes
            .iter()
            .any(|s| s.scheme == "v2" && s.verified)
    );
    for invalid in [
        "".to_owned(),
        report.replace("Verifies", "DOES NOT VERIFY"),
        report.replace("Number of signers: 1", "Number of signers: 2"),
        report.replace(&"ab".repeat(32), "invalid"),
        report.replace("true", "false"),
        format!("{report}\nERROR: broken signature"),
    ] {
        assert!(signature::parse("id", invalid).is_err());
    }
}
#[tokio::test]
async fn real_subprocesses_analyze_apk_aab_and_signatures() {
    let (_directory, store, tools) = setup().await;
    let bytes = archive(&[("AndroidManifest.xml", b"fixture")]);
    let apk = upload(&store, "sample.apk", bytes.clone()).await;
    let aab = upload(&store, "sample.aab", bytes).await;
    let manifest = tools
        .manifest(&apk.id, None, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(manifest.artifact_id, apk.id);
    assert!(matches!(manifest.format, PackageFormat::Apk));
    let manifest = tools
        .manifest(&aab.id, None, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(manifest.module.as_deref(), Some("base"));
    assert!(matches!(manifest.format, PackageFormat::Aab));
    assert_eq!(
        tools
            .manifest(&aab.id, Some("feature"), CancellationToken::new())
            .await
            .unwrap()
            .module
            .as_deref(),
        Some("feature")
    );
    let signature = tools
        .signature(&apk.id, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(signature.artifact_id, apk.id);
    assert!(signature.verified);
    assert!(matches!(
        tools.signature(&aab.id, CancellationToken::new()).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        tools
            .manifest(&apk.id, Some("base"), CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        tools
            .manifest(&aab.id, Some("../bad"), CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn selected_apk_extracts_to_a_verified_downloadable_artifact() {
    let (_directory, store, tools) = setup().await;
    let apk = archive(&[("AndroidManifest.xml", b"nested fixture")]);
    let apks = upload(
        &store,
        "sample.apks",
        archive(&[("toc.pb", b"fixture"), ("splits/base-master.apk", &apk)]),
    )
    .await;
    let result = tools
        .extract_apk(&apks.id, "splits/base-master.apk", CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.source_artifact_id, apks.id);
    assert_eq!(result.entry, "splits/base-master.apk");
    assert_eq!(result.artifact.filename, "extracted.apk");
    let (_, mut stream) = store.download(&result.artifact.id).await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(bytes, apk);
    assert!(matches!(
        tools
            .extract_apk(&apks.id, "splits/missing.apk", CancellationToken::new())
            .await,
        Err(Error::NotFound(_))
    ));
    for entry in ["../evil.apk", "/evil.apk", "splits\\evil.apk", "toc.pb"] {
        assert!(matches!(
            tools
                .extract_apk(&apks.id, entry, CancellationToken::new())
                .await,
            Err(Error::Invalid(_))
        ));
    }
}
#[tokio::test]
async fn bad_nested_container_and_crc_never_publish() {
    let (_directory, store, tools) = setup().await;
    let source = upload(
        &store,
        "bad.apks",
        archive(&[("base.apk", b"not an APK container")]),
    )
    .await;
    assert!(matches!(
        tools
            .extract_apk(&source.id, "base.apk", CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
    let mut bytes = archive(&[("base.apk", b"CORRUPT-ME")]);
    let position = bytes
        .windows(10)
        .position(|window| window == b"CORRUPT-ME")
        .unwrap();
    bytes[position] ^= 1;
    let source = upload(&store, "crc.apks", bytes).await;
    assert!(matches!(
        tools
            .extract_apk(&source.id, "base.apk", CancellationToken::new())
            .await,
        Err(Error::Invalid(_))
    ));
}
#[tokio::test]
async fn duplicate_archive_names_are_rejected_before_selection() {
    let (_directory, store, _tools) = setup().await;
    let mut bytes = archive(&[("a.apk", b"first"), ("b.apk", b"second")]);
    for start in 0..bytes.len().saturating_sub(4) {
        if &bytes[start..start + 5] == b"b.apk" {
            bytes[start] = b'a';
        }
    }
    let file = tempfile::NamedTempFile::new().unwrap();
    tokio::fs::write(file.path(), bytes).await.unwrap();
    let reader = tokio::fs::File::open(file.path()).await.unwrap();
    let result = store
        .put(
            "duplicate.apks".into(),
            Box::pin(ReaderStream::new(reader).map_err(|e| Error::Storage(e.to_string()))),
        )
        .await;
    assert!(matches!(result, Err(Error::Invalid(_))));
}
#[tokio::test]
async fn tool_errors_cancellation_configuration_and_corruption() {
    let (directory, store, mut tools) = setup().await;
    let bytes = archive(&[("AndroidManifest.xml", b"fixture")]);
    let apk = upload(&store, "sample.apk", bytes.clone()).await;
    for mode in ["silent", "invalid", "nonzero"] {
        tools.apkanalyzer = command(mode);
        assert!(matches!(
            tools
                .manifest(&apk.id, None, CancellationToken::new())
                .await,
            Err(Error::Dependency(_))
        ));
        tools.apksigner = command(mode);
        assert!(matches!(
            tools.signature(&apk.id, CancellationToken::new()).await,
            Err(Error::Dependency(_))
        ));
    }
    tools.apkanalyzer = command("slow");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        trigger.cancel();
    });
    assert!(matches!(
        tools.manifest(&apk.id, None, cancel).await,
        Err(Error::Cancelled)
    ));
    tools.bundletool = None;
    let aab = upload(&store, "sample.aab", bytes).await;
    assert!(matches!(
        tools
            .manifest(&aab.id, None, CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    let path = directory.path().join(&apk.id).join("content");
    let mut content = tokio::fs::read(&path).await.unwrap();
    content[0] ^= 1;
    tokio::fs::write(path, content).await.unwrap();
    assert!(matches!(
        tools
            .manifest(&apk.id, None, CancellationToken::new())
            .await,
        Err(Error::Storage(_))
    ));
}
#[test]
fn multiple_signers_and_limits_are_explicit() {
    let report = include_str!("fixtures/signature.txt")
        .replace("Number of signers: 1", "Number of signers: 2");
    let report = format!(
        "{report}\nSigner #2 certificate DN: CN=Second\nSigner #2 certificate SHA-256 digest: {}",
        "cd".repeat(32)
    );
    assert_eq!(signature::parse("id", report).unwrap().signers.len(), 2);
    let xml = format!(
        "<manifest package='com.example'>{}</manifest>",
        " ".repeat(1024 * 1024)
    );
    assert!(matches!(
        manifest::parse("id", PackageFormat::Apk, None, xml),
        Err(Error::TooLarge)
    ));
    let xml = format!(
        "<manifest package='com.example'>{}</manifest>",
        "<node/>".repeat(20_000)
    );
    assert!(matches!(
        manifest::parse("id", PackageFormat::Apk, None, xml),
        Err(Error::TooLarge)
    ));
}
#[tokio::test]
async fn oversized_entry_and_pre_cancelled_extraction_are_rejected() {
    let (_directory, store, tools) = setup().await;
    let mut bytes = archive(&[("base.apk", b"fixture")]);
    let central = bytes
        .windows(4)
        .position(|value| value == b"PK\x01\x02")
        .unwrap();
    bytes[22..26].copy_from_slice(&((LIMIT + 1) as u32).to_le_bytes());
    bytes[central + 24..central + 28].copy_from_slice(&((LIMIT + 1) as u32).to_le_bytes());
    let source = upload(&store, "oversized.apks", bytes).await;
    assert!(matches!(
        tools
            .extract_apk(&source.id, "base.apk", CancellationToken::new())
            .await,
        Err(Error::TooLarge)
    ));
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        tools.extract_apk(&source.id, "base.apk", token).await,
        Err(Error::Cancelled)
    ));
}
