use crate::fixture::{Fixture, Flow, samples, store::Delays};
use apk_domain::{
    Error, ExecutionContext,
    artifacts::ArtifactStore,
    packages::{PackageAnalyzer, PackageFormat},
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    fs,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

fn live_context() -> ExecutionContext {
    ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(30)),
    }
}

#[tokio::test]
async fn public_manifest_tool_maps_full_independent_dto() {
    let fixture = Fixture::new(Delays::default()).await;
    let source = fixture.source(Flow::Manifest).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await
        .expect("真实模拟工具到公开 DTO");
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "artifact_id": source.id,
            "format": "apk", "module": null,
            "package_name": "com.example.context",
            "version_code": "42", "version_name": "1 & 2",
            "min_sdk": "23", "target_sdk": "35",
            "application_label": "@string/app_name", "debuggable": false,
            "permissions": ["android.permission.INTERNET"], "xml": samples::MANIFEST,
        })
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    let argv = fs::read_to_string(fixture.control.join("argv.txt")).unwrap();
    assert!(argv.starts_with("manifest\nprint\n"));
    let input_path = fs::read_to_string(fixture.control.join("input-path.txt")).unwrap();
    assert_eq!(argv, format!("manifest\nprint\n{input_path}"));
    assert_eq!(
        fs::read_to_string(fixture.control.join("exit.code")).unwrap(),
        "0"
    );
}

#[tokio::test]
async fn public_manifest_rejects_undefined_namespace_entity_as_old_dependency() {
    let fixture = Fixture::new(Delays::default()).await;
    fixture.manifest_text(samples::UNDEFINED_ENTITY);
    let source = fixture.source(Flow::Manifest).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await;
    assert!(
        matches!(result, Err(Error::Dependency(ref message)) if message == "工具返回的 AndroidManifest XML 无效"),
        "实体错误不得变成成功或其它错误：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn public_manifest_decodes_entity_equivalent_android_uri_into_dto() {
    let fixture = Fixture::new(Delays::default()).await;
    fixture.manifest_text(samples::ENTITY_URI);
    let source = fixture.source(Flow::Manifest).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await
        .expect("等价 URI 不能漏读 Android 字段");
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "artifact_id": source.id, "format": "apk", "module": null,
            "package_name": "com.example.context", "version_code": null,
            "version_name": "entity", "min_sdk": null, "target_sdk": null,
            "application_label": null, "debuggable": true,
            "permissions": [], "xml": samples::ENTITY_URI,
        })
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn public_manifest_rejects_same_attribute_through_equivalent_prefixes() {
    let fixture = Fixture::new(Delays::default()).await;
    fixture.manifest_text(samples::EQUIVALENT_DUPLICATE);
    let source = fixture.source(Flow::Manifest).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await;
    assert!(
        matches!(result, Err(Error::Dependency(ref message)) if message == "工具返回的 AndroidManifest XML 无效"),
        "重复属性必须沿旧 Dependency：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn public_signature_preserves_old_fields_and_scrubs_materialized_path() {
    let fixture = Fixture::new(Delays::default()).await;
    let source = fixture.source(Flow::Signature).await;
    let result = fixture
        .tools
        .signature_with_context(&source.id, CancellationToken::new(), live_context())
        .await
        .expect("真实模拟签名工具");
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "artifact_id": source.id, "verified": true,
            "signers": [{"number": 1, "distinguished_name": "CN=Package Context", "certificate_sha256": "ab".repeat(32)}],
            "schemes": [{"scheme":"v1", "verified":false},{"scheme":"v2", "verified":true},{"scheme":"v3", "verified":false}],
            "report": samples::SIGNATURE.replace("@INPUT@", "sample.apk"),
        })
    );
    let input_path = fs::read_to_string(fixture.control.join("input-path.txt")).unwrap();
    assert!(!result.report.contains(&input_path));
    assert_eq!(
        fs::read_to_string(fixture.control.join("argv.txt")).unwrap(),
        format!("verify\n--verbose\n--print-certs\n{input_path}")
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn zero_exit_incomplete_signature_keeps_exact_old_dependency() {
    let fixture = Fixture::new(Delays::default()).await;
    fixture.signature_text("Verifies\nNumber of signers: 1\n");
    let source = fixture.source(Flow::Signature).await;
    let result = fixture
        .tools
        .signature_with_context(&source.id, CancellationToken::new(), live_context())
        .await;
    assert!(
        matches!(result, Err(Error::Dependency(ref message)) if message == "签名工具未返回完整、明确的验证结果"),
        "零退出不是签名资格：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(
        fs::read_to_string(fixture.control.join("exit.code")).unwrap(),
        "0"
    );
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn normal_extract_publishes_one_artifact_with_original_input_bytes() {
    let fixture = Fixture::new(Delays::default()).await;
    let expected = samples::apk();
    let source = fixture.source(Flow::Extract).await;
    let result = fixture
        .tools
        .extract_apk_with_context(
            &source.id,
            samples::ENTRY,
            CancellationToken::new(),
            live_context(),
        )
        .await
        .expect("真实公共核心复制并发布");
    assert_eq!(result.source_artifact_id, source.id);
    assert_eq!(result.entry, samples::ENTRY);
    assert_ne!(result.artifact.id, source.id);
    assert_eq!(result.artifact.filename, "extracted.apk");
    assert_eq!(result.artifact.size, u64::try_from(expected.len()).unwrap());
    assert_eq!(
        result.artifact.sha256,
        format!("{:x}", Sha256::digest(&expected))
    );
    let (metadata, mut stream) = fixture
        .store
        .inner
        .download(&result.artifact.id)
        .await
        .expect("真实已发布下载");
    assert_eq!(
        serde_json::to_value(metadata).unwrap(),
        serde_json::to_value(&result.artifact).unwrap()
    );
    let mut downloaded = Vec::new();
    while let Some(chunk) = stream.next().await {
        downloaded.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(downloaded, expected);
    assert_eq!(fixture.store.counts(), (1, 1, 1));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn missing_and_unsafe_extract_entries_keep_old_exact_errors() {
    let fixture = Fixture::new(Delays::default()).await;
    let source = fixture.source(Flow::Extract).await;
    let result = fixture
        .tools
        .extract_apk_with_context(
            &source.id,
            "missing.apk",
            CancellationToken::new(),
            live_context(),
        )
        .await;
    assert!(
        matches!(result, Err(Error::NotFound(ref message)) if message == "APKS 内不存在指定 APK 条目"),
        "缺项必须精确 NotFound：{result:?}"
    );
    for entry in [
        "../escape.apk",
        "/escape.apk",
        "folder\\escape.apk",
        "toc.pb",
    ] {
        let result = fixture
            .tools
            .extract_apk_with_context(&source.id, entry, CancellationToken::new(), live_context())
            .await;
        assert!(
            matches!(result, Err(Error::Invalid(ref message)) if message == "必须选择 APKS 内不含越界路径的 APK 条目"),
            "参数错误必须精确 Invalid：{result:?}"
        );
    }
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn corrupted_selected_crc_fails_before_any_publication() {
    let fixture = Fixture::new(Delays::default()).await;
    let mut bytes = samples::apks();
    let offset = bytes
        .windows(b"synthetic binary manifest".len())
        .position(|value| value == b"synthetic binary manifest")
        .expect("固定正文位置");
    // 不改任何 header/CRC；外层结构保持可上传，选中流完整校验必须失败。
    bytes[offset] ^= 1;
    let source = fixture.upload("crc.apks", &bytes).await;
    let result = fixture
        .tools
        .extract_apk_with_context(
            &source.id,
            samples::ENTRY,
            CancellationToken::new(),
            live_context(),
        )
        .await;
    assert!(
        matches!(result, Err(Error::Invalid(ref message)) if message == "APK 条目解压或 CRC 校验失败"),
        "只接受复制 CRC 阶段错误：{result:?}"
    );
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn aab_default_explicit_module_and_apk_module_rejection_preserve_old_dto() {
    let fixture = Fixture::new(Delays::default()).await;
    let source = fixture.upload("sample.aab", &samples::apk()).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await
        .unwrap();
    assert!(matches!(result.format, PackageFormat::Aab));
    assert_eq!(result.module.as_deref(), Some("base"));
    assert_eq!(result.artifact_id, source.id);
    fixture.assert_tool_exited().await;
    // 每次工具调用独立控制目录，避免前次 ready/exit 标记冒充第二次进程。
    let second = Fixture::new(Delays::default()).await;
    let source = second.upload("sample.aab", &samples::apk()).await;
    let result = second
        .tools
        .manifest_with_context(
            &source.id,
            Some("feature"),
            CancellationToken::new(),
            live_context(),
        )
        .await
        .unwrap();
    assert_eq!(result.module.as_deref(), Some("feature"));
    assert!(matches!(result.format, PackageFormat::Aab));
    second.assert_tool_exited().await;
    let third = Fixture::new(Delays::default()).await;
    let source = third.source(Flow::Manifest).await;
    let result = third
        .tools
        .manifest_with_context(
            &source.id,
            Some("base"),
            CancellationToken::new(),
            live_context(),
        )
        .await;
    assert!(
        matches!(result, Err(Error::Invalid(ref message)) if message == "APK 不接受 AAB 模块参数")
    );
    third.assert_no_tool();
    assert_eq!(third.store.counts(), (1, 0, 0));
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert_eq!(second.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn nonzero_tool_exit_stays_dependency_and_really_exits() {
    let mut fixture = Fixture::new(Delays::default()).await;
    fixture.set_tool_mode("nonzero");
    let source = fixture.source(Flow::Manifest).await;
    let result = fixture
        .tools
        .manifest_with_context(&source.id, None, CancellationToken::new(), live_context())
        .await;
    assert!(
        matches!(result, Err(Error::Dependency(_))),
        "工具非零沿 Dependency，不能接受任意错误：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(
        fs::read_to_string(fixture.control.join("exit.code")).unwrap(),
        "7"
    );
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}
