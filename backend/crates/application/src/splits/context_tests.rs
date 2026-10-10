use super::SplitOperations;
use apk_domain::{
    Error, ExecutionContext, Executor, Result,
    artifacts::Artifact,
    splits::{
        ApksInstalled, DeviceSpec, ExtractSplitsRequest, ExtractedSplits, InstallApksRequest,
        SplitPackages,
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

const ID: &str = "3b9e35ac-f5b1-422f-a9eb-5024e7f8f7be";
const EXTRACT: &str = "android.package.extract_splits";
const INSTALL: &str = "android.app.install_apks";

#[derive(Clone)]
struct Call {
    operation: &'static str,
    request: Value,
    context: Option<ExecutionContext>,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<Call>>,
    unresolved: AtomicBool,
    unresolved_after_extract: AtomicBool,
}

impl Recorder {
    fn record(
        &self,
        operation: &'static str,
        request: Value,
        cancel: CancellationToken,
        context: Option<ExecutionContext>,
    ) {
        self.calls.lock().expect("调用记录锁").push(Call {
            operation,
            request,
            cancel,
            context,
        });
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("调用记录锁").clone()
    }
}

fn extract_request() -> ExtractSplitsRequest {
    ExtractSplitsRequest {
        artifact_id: ID.into(),
        device_spec: DeviceSpec {
            supported_abis: vec!["arm64-v8a".into(), "armeabi-v7a".into()],
            supported_locales: vec!["zh_CN".into(), "en".into()],
            screen_density: 480,
            sdk_version: 33,
        },
    }
}

fn install_request() -> InstallApksRequest {
    InstallApksRequest {
        artifact_id: ID.into(),
        device_id: "192.0.2.1:5555".into(),
    }
}

fn extracted(request: &ExtractSplitsRequest) -> ExtractedSplits {
    ExtractedSplits {
        source_artifact_id: request.artifact_id.clone(),
        device_spec: request.device_spec.clone(),
        artifact: Artifact {
            id: "b4267a20-79b1-4b07-a05a-a7de89a38397".into(),
            filename: "extracted.zip".into(),
            media_type: "application/zip".into(),
            size: 42,
            sha256: "ab".repeat(32),
            created_at: 123,
        },
        apk_entries: vec!["base-master.apk".into(), "base-arm64_v8a.apk".into()],
    }
}

fn installed(request: &InstallApksRequest) -> ApksInstalled {
    ApksInstalled {
        artifact_id: request.artifact_id.clone(),
        device_id: request.device_id.clone(),
        installed: true,
    }
}

fn cases() -> [(&'static str, Value, Value); 2] {
    let extract = extract_request();
    let install = install_request();
    [
        (
            EXTRACT,
            serde_json::to_value(&extract).unwrap(),
            serde_json::to_value(extracted(&extract)).unwrap(),
        ),
        (
            INSTALL,
            serde_json::to_value(&install).unwrap(),
            serde_json::to_value(installed(&install)).unwrap(),
        ),
    ]
}

fn context() -> ExecutionContext {
    ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    }
}

#[async_trait]
impl SplitPackages for Recorder {
    async fn extract(
        &self,
        _: ExtractSplitsRequest,
        _: CancellationToken,
    ) -> Result<ExtractedSplits> {
        panic!("应用必须调用提取 context 入口")
    }

    async fn extract_with_context(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<ExtractedSplits> {
        self.record(
            EXTRACT,
            serde_json::to_value(&request).unwrap(),
            cancel,
            Some(context),
        );
        if self.unresolved_after_extract.load(Ordering::SeqCst) {
            self.unresolved.store(true, Ordering::SeqCst);
        }
        Ok(extracted(&request))
    }

    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled> {
        self.record(
            INSTALL,
            serde_json::to_value(&request).unwrap(),
            cancel,
            None,
        );
        Ok(installed(&request))
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}

/// 安装和提取仍只实现旧必需方法，无安装 context 加法。
#[derive(Default)]
struct LegacySplits(Recorder);

#[async_trait]
impl SplitPackages for LegacySplits {
    async fn extract(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
    ) -> Result<ExtractedSplits> {
        self.0.record(
            EXTRACT,
            serde_json::to_value(&request).unwrap(),
            cancel,
            None,
        );
        Ok(extracted(&request))
    }

    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled> {
        self.0.record(
            INSTALL,
            serde_json::to_value(&request).unwrap(),
            cancel,
            None,
        );
        Ok(installed(&request))
    }
}

#[tokio::test]
async fn extract_gets_original_deadline_and_install_keeps_the_old_port() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    let context = context();
    let parent = CancellationToken::new();
    let cancel = parent.child_token();
    for (operation, input, expected) in cases() {
        let result = executor
            .execute_with_context(operation, input, cancel.clone(), context)
            .await
            .unwrap();
        assert_eq!(result, expected);
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    for (call, (operation, input, _)) in calls.iter().zip(cases()) {
        assert_eq!(call.operation, operation);
        assert_eq!(call.request, input);
        assert!(!call.cancel.is_cancelled());
    }
    assert_eq!(
        calls[0].context.unwrap().deadline,
        context.deadline,
        "原截止点不得刷新"
    );
    assert!(
        calls[1].context.is_none(),
        "安装仍使用旧端口，不宣称接通同一截止点"
    );
    parent.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
}

#[tokio::test]
async fn old_execute_uses_default_extract_context_and_the_old_install_port() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    for (operation, input, expected) in cases() {
        let result = executor
            .execute(operation, input, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result, expected);
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].context.unwrap().deadline.is_none());
    assert!(calls[1].context.is_none());
}

#[tokio::test]
async fn default_extract_context_supports_a_legacy_only_split_adapter() {
    let legacy = Arc::new(LegacySplits::default());
    let executor = SplitOperations(legacy.clone());
    let cancel = CancellationToken::new();
    for (operation, input, expected) in cases() {
        let result = executor
            .execute_with_context(operation, input, cancel.clone(), context())
            .await
            .unwrap();
        assert_eq!(result, expected);
    }
    let calls = legacy.0.calls();
    assert_eq!(calls.len(), 2);
    for (call, (operation, input, _)) in calls.iter().zip(cases()) {
        assert_eq!(call.operation, operation);
        assert_eq!(call.request, input);
        assert!(call.context.is_none());
    }
    cancel.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
    assert!(!executor.has_unresolved_resources());
}

#[tokio::test]
async fn cancelled_or_expired_preflight_makes_zero_extract_and_install_calls() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    for operation in [EXTRACT, INSTALL] {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            matches!(
                executor
                    .execute_with_context(operation, json!({}), cancel, context())
                    .await,
                Err(Error::Cancelled)
            ),
            "取消预检必须先于请求转换"
        );
        assert!(
            matches!(
                executor
                    .execute_with_context(
                        operation,
                        json!({}),
                        CancellationToken::new(),
                        ExecutionContext {
                            deadline: Some(Instant::now() - Duration::from_secs(1)),
                        }
                    )
                    .await,
                Err(Error::Timeout)
            ),
            "到期预检必须先于请求转换"
        );
    }
    for (operation, input, _) in cases() {
        for deadline in [None, context().deadline] {
            let cancel = CancellationToken::new();
            cancel.cancel();
            assert!(matches!(
                executor
                    .execute_with_context(
                        operation,
                        input.clone(),
                        cancel,
                        ExecutionContext { deadline }
                    )
                    .await,
                Err(Error::Cancelled)
            ));
        }
        for cancelled in [false, true] {
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            assert!(
                matches!(
                    executor
                        .execute_with_context(
                            operation,
                            input.clone(),
                            cancel,
                            ExecutionContext {
                                deadline: Some(Instant::now() - Duration::from_secs(1)),
                            }
                        )
                        .await,
                    Err(Error::Timeout)
                ),
                "到期与取消同现时应优先诊断到期"
            );
        }
    }
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn invalid_requests_keep_validation_and_do_not_call_split_ports() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    let valid_extract = serde_json::to_value(extract_request()).unwrap();
    let mut duplicate = valid_extract.clone();
    duplicate["device_spec"]["supported_abis"] = json!(["arm64-v8a", "arm64-v8a"]);
    let mut empty_locales = valid_extract.clone();
    empty_locales["device_spec"]["supported_locales"] = json!([]);
    let mut zero_density = valid_extract.clone();
    zero_density["device_spec"]["screen_density"] = json!(0);
    let mut unknown_field = valid_extract.clone();
    unknown_field["tool"] = json!("caller-choice");
    let mut invalid_id = valid_extract;
    invalid_id["artifact_id"] = json!("not-a-uuid");
    for (operation, invalid) in [
        (EXTRACT, json!({})),
        (EXTRACT, duplicate),
        (EXTRACT, empty_locales),
        (EXTRACT, zero_density),
        (EXTRACT, unknown_field),
        (EXTRACT, invalid_id),
        (INSTALL, json!([])),
        (INSTALL, json!({"artifact_id": ID})),
        (INSTALL, json!({"artifact_id": ID, "device_id": "../bad"})),
        (
            INSTALL,
            json!({"artifact_id": ID, "device_id": "device", "unexpected": true}),
        ),
    ] {
        assert!(matches!(
            executor
                .execute_with_context(operation, invalid, CancellationToken::new(), context())
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn unknown_operation_keeps_budget_then_match_order() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    let unknown = "unknown.split";
    let result = executor
        .execute(unknown, json!({}), CancellationToken::new())
        .await;
    assert!(matches!(result, Err(Error::NotFound(id)) if id == unknown));
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        executor.execute(unknown, json!({}), cancel).await,
        Err(Error::Cancelled)
    ));
    for cancelled in [false, true] {
        let cancel = CancellationToken::new();
        if cancelled {
            cancel.cancel();
        }
        assert!(matches!(
            executor
                .execute_with_context(
                    unknown,
                    json!({}),
                    cancel,
                    ExecutionContext {
                        deadline: Some(Instant::now() - Duration::from_secs(1)),
                    }
                )
                .await,
            Err(Error::Timeout)
        ));
    }
    assert!(recorder.calls().is_empty());
}

#[test]
fn unresolved_resources_are_forwarded_live() {
    let recorder = Arc::new(Recorder::default());
    let executor = SplitOperations(recorder.clone());
    assert!(!executor.has_unresolved_resources());
    recorder.unresolved.store(true, Ordering::SeqCst);
    assert!(executor.has_unresolved_resources());
    recorder.unresolved.store(false, Ordering::SeqCst);
    assert!(!executor.has_unresolved_resources());
}

#[tokio::test]
async fn extract_unconfirmed_resources_remain_visible_after_legacy_install_success() {
    let recorder = Arc::new(Recorder::default());
    recorder
        .unresolved_after_extract
        .store(true, Ordering::SeqCst);
    let executor = SplitOperations(recorder.clone());
    assert!(!executor.has_unresolved_resources());
    for (operation, input, expected) in cases() {
        let result = executor
            .execute_with_context(operation, input, CancellationToken::new(), context())
            .await
            .unwrap();
        assert_eq!(result, expected);
        assert!(
            executor.has_unresolved_resources(),
            "后续安装成功不能隐藏提取留下的适配器风险"
        );
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].operation, INSTALL);
    assert!(calls[1].context.is_none());
    // 本测试只验证旧端口与共享观测；任务层据观测收口的诊断另由集成验收。
}
