use crate::fixture::{Fixture, Flow, join_live, live_context, samples, store::Delays};
use apk_domain::{
    artifacts::{Artifact, ArtifactStore},
    bundles::{BuildApksRequest, BuildMode, BundleBuilder},
    reverse::PackageReverse,
    splits::{ExtractSplitsRequest, SplitPackages},
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
};
use tokio_util::sync::CancellationToken;

async fn downloaded(fixture: &Fixture, artifact: &Artifact) -> Vec<u8> {
    let (metadata, mut stream) = fixture
        .store
        .inner
        .download(&artifact.id)
        .await
        .expect("真实发布产物可下载");
    assert_eq!(
        serde_json::to_value(metadata).unwrap(),
        serde_json::to_value(artifact).unwrap()
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(artifact.size, bytes.len() as u64);
    assert_eq!(artifact.sha256, format!("{:x}", Sha256::digest(&bytes)));
    bytes
}

fn exact_members(bytes: &[u8], expected: &[(&str, &[u8])]) {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("独立读回 ZIP");
    assert_eq!(archive.len(), expected.len(), "不得发布额外或重复成员");
    let mut actual = BTreeMap::new();
    for index in 0..archive.len() {
        let mut member = archive.by_index(index).unwrap();
        assert!(!member.is_dir());
        let name = member.name().to_owned();
        let mut data = Vec::new();
        member
            .read_to_end(&mut data)
            .expect("成员 CRC 和原字节完整读回");
        assert!(actual.insert(name, data).is_none(), "下载成员不得重名");
    }
    let expected: BTreeMap<_, _> = expected
        .iter()
        .map(|(name, data)| (name.to_string(), data.to_vec()))
        .collect();
    assert_eq!(actual, expected, "逐成员原字节必须来自独立固定样本");
}

async fn successful_tool(fixture: &Fixture, pid: u32) {
    assert_eq!(fixture.pid(), pid);
    fixture.assert_tool_exited().await;
    assert_eq!(
        fs::read_to_string(fixture.control.join("exit.code")).unwrap(),
        "0"
    );
    assert_eq!(
        fs::read_to_string(fixture.control.join("response_written")).unwrap(),
        "1"
    );
    assert_eq!(fixture.store.counts(), (1, 1, 1));
}

#[tokio::test]
async fn build_default_and_universal_preserve_full_dto_and_original_apks_bytes() {
    for (mode, universal) in [(BuildMode::Default, false), (BuildMode::Universal, true)] {
        // 每个实际工具调用有独立根，前次 ready 不能冒充第二个 PID。
        let fixture = Fixture::new("hold", Delays::default()).await;
        let source = fixture.source(Flow::Build).await;
        let adapter = fixture.bundles.clone();
        let source_id = source.id.clone();
        let task = tokio::spawn(async move {
            adapter
                .build_with_context(
                    BuildApksRequest {
                        artifact_id: source_id,
                        mode,
                    },
                    CancellationToken::new(),
                    live_context(),
                )
                .await
        });
        let pid = fixture.ready().await;
        assert!(!task.is_finished());
        fs::write(fixture.control.join("release"), b"1").unwrap();
        let result = join_live(task).await.expect("公开 Bundle 正向");
        assert_ne!(result.artifact.id, source.id);
        assert_eq!(result.artifact.filename, "built.apks");
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::json!({
                "source_artifact_id": source.id,
                "mode": if universal { "universal" } else { "default" },
                "artifact": result.artifact,
                "apk_count": if universal { 1 } else { 2 },
                "universal_entry": if universal { Some("universal.apk") } else { None },
            })
        );
        assert_eq!(
            downloaded(&fixture, &result.artifact).await,
            samples::apks(universal)
        );
        let argv = fs::read_to_string(fixture.control.join("argv.txt")).unwrap();
        assert!(argv.starts_with("build-apks\n--bundle="));
        assert!(argv.contains(if universal {
            "\n--mode=universal\n"
        } else {
            "\n--mode=default\n"
        }));
        successful_tool(&fixture, pid).await;
    }
}

#[tokio::test]
async fn decode_preserves_full_dto_and_each_resource_smali_byte() {
    let fixture = Fixture::new("hold", Delays::default()).await;
    let source = fixture.source(Flow::Decode).await;
    let adapter = fixture.reverse.clone();
    let source_id = source.id.clone();
    let task = tokio::spawn(async move {
        adapter
            .decode_with_context(&source_id, CancellationToken::new(), live_context())
            .await
    });
    let pid = fixture.ready().await;
    assert!(!task.is_finished());
    fs::write(fixture.control.join("release"), b"1").unwrap();
    let result = join_live(task).await.expect("公开 Reverse.decode 正向");
    assert_ne!(result.artifact.id, source.id);
    assert_eq!(result.artifact.filename, "decoded.zip");
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "source_artifact_id": source.id,
            "artifact": result.artifact,
            "files": samples::DECODED_FILES.len(),
            "unpacked_size": samples::DECODED_FILES.iter().map(|(_, bytes)| bytes.len() as u64).sum::<u64>(),
        })
    );
    exact_members(
        &downloaded(&fixture, &result.artifact).await,
        samples::DECODED_FILES,
    );
    let argv = fs::read_to_string(fixture.control.join("argv.txt")).unwrap();
    let input = fs::read_to_string(fixture.control.join("input-path.txt")).unwrap();
    assert!(argv.starts_with(&format!("decode\n{input}\n--output\n")));
    assert!(argv.contains("\n--frame-path\n"));
    successful_tool(&fixture, pid).await;
}

#[tokio::test]
async fn scan_preserves_complete_findings_boundary_and_never_uses_tool_or_put() {
    let fixture = Fixture::new("response", Delays::default()).await;
    let source = fixture.source(Flow::Scan).await;
    let result = fixture
        .reverse
        .scan_sdks_with_context(
            &source.id,
            samples::rules(),
            CancellationToken::new(),
            live_context(),
        )
        .await
        .expect("公开无工具扫描");
    let evidence = vec![
        "smali/com/example/sdk/Entry.smali",
        "smali_classes2/com/example/sdk/Entry$Inner.smali",
    ];
    let rules = samples::rules();
    let expected: Vec<_> = rules
        .iter()
        .enumerate()
        .map(|(index, rule)| {
            let class_found = match index {
                0 | 1 => Some(true),
                2 => Some(false),
                _ => None,
            };
            serde_json::json!({
                "rule": rule, "package_found": index != 4, "class_found": class_found,
                "evidence": if index == 4 { Vec::<&str>::new() } else { evidence.clone() },
            })
        })
        .collect();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({
            "artifact_id": source.id, "findings": expected,
        })
    );
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn extract_preserves_spec_full_dto_sorted_entries_and_original_apk_members() {
    let fixture = Fixture::new("hold", Delays::default()).await;
    let source = fixture.source(Flow::Extract).await;
    let adapter = fixture.splits.clone();
    let source_id = source.id.clone();
    let task = tokio::spawn(async move {
        adapter
            .extract_with_context(
                ExtractSplitsRequest {
                    artifact_id: source_id,
                    device_spec: samples::spec(),
                },
                CancellationToken::new(),
                live_context(),
            )
            .await
    });
    let pid = fixture.ready().await;
    assert!(!task.is_finished());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(fixture.control.join("device-spec.json")).unwrap()
        )
        .unwrap(),
        serde_json::json!({"supportedAbis": ["arm64-v8a"], "supportedLocales": ["zh", "en"], "screenDensity": 420, "sdkVersion": 35})
    );
    fs::write(fixture.control.join("release"), b"1").unwrap();
    let result = join_live(task).await.expect("公开 Split.extract 正向");
    assert_ne!(result.artifact.id, source.id);
    assert_eq!(result.artifact.filename, "selected-apks.zip");
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "source_artifact_id": source.id, "device_spec": samples::spec(), "artifact": result.artifact,
            "apk_entries": ["base-arm64.apk", "base-master.apk"],
        })
    );
    let base = samples::apk();
    let configuration = samples::configuration_apk();
    exact_members(
        &downloaded(&fixture, &result.artifact).await,
        &[
            ("base-master.apk", &base),
            ("base-arm64.apk", &configuration),
        ],
    );
    assert!(
        fs::read_to_string(fixture.control.join("argv.txt"))
            .unwrap()
            .starts_with("extract-apks\n--apks=")
    );
    successful_tool(&fixture, pid).await;
}
