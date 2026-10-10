use super::PackageOperations;
use apk_domain::{
    Error, ExecutionContext, Executor, Result,
    artifacts::Artifact,
    packages::{
        ExtractedApk, PackageAnalyzer, PackageFormat, PackageManifest, PackageSignature,
        PackageSigner, SignatureScheme,
    },
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const ARTIFACT_ID: &str = "3b9e35ac-f5b1-422f-a9eb-5024e7f8f7be";
const MANIFEST: &str = "android.package.manifest";
const SIGNATURE: &str = "android.package.signature";
const EXTRACT_APK: &str = "android.package.extract_apk";

#[derive(Clone)]
struct Call {
    operation: &'static str,
    artifact_id: String,
    extra: Option<String>,
    context: ExecutionContext,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<Call>>,
    unresolved: AtomicBool,
}

impl Recorder {
    fn record(
        &self,
        operation: &'static str,
        id: &str,
        extra: Option<&str>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) {
        self.calls.lock().expect("调用记录锁").push(Call {
            operation,
            artifact_id: id.into(),
            extra: extra.map(str::to_owned),
            context,
            cancel,
        });
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("调用记录锁").clone()
    }
}

fn manifest(id: &str, module: Option<&str>) -> PackageManifest {
    PackageManifest {
        artifact_id: id.into(),
        format: PackageFormat::Aab,
        module: module.map(str::to_owned),
        package_name: "example.context".into(),
        version_code: Some("003".into()),
        version_name: None,
        min_sdk: Some("21".into()),
        target_sdk: None,
        application_label: Some("@string/app_name".into()),
        debuggable: Some(false),
        permissions: vec!["android.permission.INTERNET".into()],
        xml: "<manifest package='example.context'/>".into(),
    }
}

fn signature(id: &str) -> PackageSignature {
    PackageSignature {
        artifact_id: id.into(),
        verified: true,
        signers: vec![PackageSigner {
            number: 1,
            distinguished_name: None,
            certificate_sha256: "ab".repeat(32),
        }],
        schemes: vec![SignatureScheme {
            scheme: "v2".into(),
            verified: true,
        }],
        report: "已脱敏的签名报告".into(),
    }
}

fn extracted(id: &str, entry: &str) -> ExtractedApk {
    ExtractedApk {
        source_artifact_id: id.into(),
        entry: entry.into(),
        artifact: Artifact {
            id: "b4267a20-79b1-4b07-a05a-a7de89a38397".into(),
            filename: "extracted.apk".into(),
            media_type: "application/zip".into(),
            size: 42,
            sha256: "cd".repeat(32),
            created_at: 123,
        },
    }
}

fn cases() -> [(&'static str, Value, Option<&'static str>); 3] {
    [
        (
            MANIFEST,
            json!({"artifact_id": ARTIFACT_ID, "module": "feature_demo"}),
            Some("feature_demo"),
        ),
        (SIGNATURE, json!({"artifact_id": ARTIFACT_ID}), None),
        (
            EXTRACT_APK,
            json!({"artifact_id": ARTIFACT_ID, "entry": "splits/base.apk"}),
            Some("splits/base.apk"),
        ),
    ]
}

fn expected(operation: &str, extra: Option<&str>) -> Value {
    match operation {
        MANIFEST => serde_json::to_value(manifest(ARTIFACT_ID, extra)).unwrap(),
        SIGNATURE => serde_json::to_value(signature(ARTIFACT_ID)).unwrap(),
        EXTRACT_APK => serde_json::to_value(extracted(ARTIFACT_ID, extra.unwrap())).unwrap(),
        _ => panic!("测试操作必须为三项包分析操作"),
    }
}

#[async_trait]
impl PackageAnalyzer for Recorder {
    async fn manifest(
        &self,
        _: &str,
        _: Option<&str>,
        _: CancellationToken,
    ) -> Result<PackageManifest> {
        panic!("应用必须调用清单 context 入口")
    }

    async fn signature(&self, _: &str, _: CancellationToken) -> Result<PackageSignature> {
        panic!("应用必须调用签名 context 入口")
    }

    async fn extract_apk(&self, _: &str, _: &str, _: CancellationToken) -> Result<ExtractedApk> {
        panic!("应用必须调用提取 context 入口")
    }

    async fn manifest_with_context(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<PackageManifest> {
        self.record(MANIFEST, id, module, cancel, context);
        Ok(manifest(id, module))
    }

    async fn signature_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<PackageSignature> {
        self.record(SIGNATURE, id, None, cancel, context);
        Ok(signature(id))
    }

    async fn extract_apk_with_context(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<ExtractedApk> {
        self.record(EXTRACT_APK, id, Some(entry), cancel, context);
        Ok(extracted(id, entry))
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}

/// 只实现旧三方法，验证领域默认入口不要求已有适配器增加必需方法。
#[derive(Default)]
struct LegacyAnalyzer(Recorder);

#[async_trait]
impl PackageAnalyzer for LegacyAnalyzer {
    async fn manifest(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<PackageManifest> {
        self.0
            .record(MANIFEST, id, module, cancel, ExecutionContext::default());
        Ok(manifest(id, module))
    }

    async fn signature(&self, id: &str, cancel: CancellationToken) -> Result<PackageSignature> {
        self.0
            .record(SIGNATURE, id, None, cancel, ExecutionContext::default());
        Ok(signature(id))
    }

    async fn extract_apk(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
    ) -> Result<ExtractedApk> {
        self.0.record(
            EXTRACT_APK,
            id,
            Some(entry),
            cancel,
            ExecutionContext::default(),
        );
        Ok(extracted(id, entry))
    }
}

#[tokio::test]
async fn all_three_context_paths_preserve_original_deadline_input_token_and_result() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    let context = ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    };
    let cancel = CancellationToken::new();
    for (operation, input, extra) in cases() {
        let result = executor
            .execute_with_context(operation, input, cancel.clone(), context)
            .await
            .unwrap();
        assert_eq!(result, expected(operation, extra));
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 3);
    for (call, (operation, _, extra)) in calls.iter().zip(cases()) {
        assert_eq!(call.operation, operation);
        assert_eq!(call.artifact_id, ARTIFACT_ID);
        assert_eq!(call.extra.as_deref(), extra);
        assert_eq!(
            call.context.deadline, context.deadline,
            "截止点不能按每个操作刷新"
        );
        assert!(!call.cancel.is_cancelled());
    }
    cancel.cancel();
    assert!(
        calls.iter().all(|call| call.cancel.is_cancelled()),
        "必须传递原取消树"
    );
}

#[tokio::test]
async fn legacy_execute_delegates_to_context_entry_with_no_deadline_for_all_three_paths() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    for (operation, input, extra) in cases() {
        let result = executor
            .execute(operation, input, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result, expected(operation, extra));
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|call| call.context.deadline.is_none()));
}

#[tokio::test]
async fn default_domain_context_methods_delegate_to_legacy_only_analyzer() {
    let legacy = Arc::new(LegacyAnalyzer::default());
    let executor = PackageOperations(legacy.clone());
    let context = ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    };
    for (operation, input, extra) in cases() {
        let result = executor
            .execute_with_context(operation, input, CancellationToken::new(), context)
            .await
            .unwrap();
        assert_eq!(result, expected(operation, extra));
    }
    let calls = legacy.0.calls();
    assert_eq!(calls.len(), 3);
    for (call, (operation, _, extra)) in calls.iter().zip(cases()) {
        assert_eq!(call.operation, operation);
        assert_eq!(call.artifact_id, ARTIFACT_ID);
        assert_eq!(call.extra.as_deref(), extra);
    }
    assert!(
        !executor.has_unresolved_resources(),
        "旧仅实现者默认没有未确认资源"
    );
}

#[tokio::test]
async fn cancelled_or_expired_preflight_never_calls_any_analyzer_port() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    for (operation, input, _) in cases() {
        for deadline in [None, Some(Instant::now() + Duration::from_secs(300))] {
            let cancel = CancellationToken::new();
            cancel.cancel();
            let result = executor
                .execute_with_context(
                    operation,
                    input.clone(),
                    cancel,
                    ExecutionContext { deadline },
                )
                .await;
            assert!(
                matches!(result, Err(Error::Cancelled)),
                "预取消不得进入端口"
            );
        }
        for cancelled in [false, true] {
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            let result = executor
                .execute_with_context(
                    operation,
                    input.clone(),
                    cancel,
                    ExecutionContext {
                        deadline: Some(Instant::now() - Duration::from_secs(1)),
                    },
                )
                .await;
            assert!(
                matches!(result, Err(Error::Timeout)),
                "到期与取消同现时按到期诊断"
            );
        }
    }
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn context_entry_preserves_input_errors_before_analyzer_calls() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    let context = ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    };
    let invalid = [
        (MANIFEST, json!({}), "缺少产物 ID"),
        (SIGNATURE, json!({"artifact_id": 3}), "缺少产物 ID"),
        (EXTRACT_APK, json!([]), "缺少产物 ID"),
        (
            MANIFEST,
            json!({"artifact_id": ARTIFACT_ID, "module": null}),
            "module 必须为字符串",
        ),
        (
            MANIFEST,
            json!({"artifact_id": ARTIFACT_ID, "module": 3}),
            "module 必须为字符串",
        ),
        (
            EXTRACT_APK,
            json!({"artifact_id": ARTIFACT_ID}),
            "缺少 APK 条目名称",
        ),
        (
            EXTRACT_APK,
            json!({"artifact_id": ARTIFACT_ID, "entry": null}),
            "缺少 APK 条目名称",
        ),
        (
            EXTRACT_APK,
            json!({"artifact_id": ARTIFACT_ID, "entry": 3}),
            "缺少 APK 条目名称",
        ),
    ];
    for (operation, input, expected_message) in invalid {
        let result = executor
            .execute_with_context(operation, input, CancellationToken::new(), context)
            .await;
        match result {
            Err(Error::Invalid(message)) => assert_eq!(message, expected_message),
            other => panic!("输入错误类别发生变化：{other:?}"),
        }
    }
    let unknown = executor
        .execute_with_context(
            "unknown.package.operation",
            json!({"artifact_id": ARTIFACT_ID}),
            CancellationToken::new(),
            context,
        )
        .await;
    assert!(
        matches!(unknown, Err(Error::NotFound(operation)) if operation == "unknown.package.operation")
    );
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn omitted_manifest_module_remains_none_in_context_entry() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    let result = executor
        .execute_with_context(
            MANIFEST,
            json!({"artifact_id": ARTIFACT_ID}),
            CancellationToken::new(),
            ExecutionContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        serde_json::to_value(manifest(ARTIFACT_ID, None)).unwrap()
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(
        calls[0].extra.is_none(),
        "应用不得自行把缺省 module 改为 base"
    );
}

#[test]
fn unresolved_resources_are_forwarded_without_caching_or_reclassification() {
    let recorder = Arc::new(Recorder::default());
    let executor = PackageOperations(recorder.clone());
    assert!(!executor.has_unresolved_resources());
    recorder.unresolved.store(true, Ordering::SeqCst);
    assert!(executor.has_unresolved_resources());
    recorder.unresolved.store(false, Ordering::SeqCst);
    assert!(!executor.has_unresolved_resources());
}
