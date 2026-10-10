use super::BundleOperations;
use apk_domain::{
    Error, ExecutionContext, Executor, Result,
    artifacts::Artifact,
    bundles::{BuildApksRequest, BuildMode, BuiltApks, BundleBuilder},
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
const BUILD: &str = "android.package.build_apks";

#[derive(Clone)]
struct Call {
    request: BuildApksRequest,
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
        request: BuildApksRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> BuiltApks {
        let result = built(&request);
        self.calls.lock().expect("调用记录锁").push(Call {
            request,
            cancel,
            context,
        });
        result
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("调用记录锁").clone()
    }
}

fn request(mode: BuildMode) -> BuildApksRequest {
    BuildApksRequest {
        artifact_id: ID.into(),
        mode,
    }
}

fn input(mode: BuildMode) -> Value {
    serde_json::to_value(request(mode)).unwrap()
}

fn built(request: &BuildApksRequest) -> BuiltApks {
    BuiltApks {
        source_artifact_id: request.artifact_id.clone(),
        mode: request.mode,
        artifact: Artifact {
            id: "b4267a20-79b1-4b07-a05a-a7de89a38397".into(),
            filename: "built.apks".into(),
            media_type: "application/zip".into(),
            size: 42,
            sha256: "ab".repeat(32),
            created_at: 123,
        },
        apk_count: 2,
        universal_entry: (request.mode == BuildMode::Universal).then(|| "universal.apk".into()),
    }
}

fn context() -> ExecutionContext {
    ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    }
}

#[async_trait]
impl BundleBuilder for Recorder {
    async fn build(&self, _: BuildApksRequest, _: CancellationToken) -> Result<BuiltApks> {
        panic!("应用必须调用构建 context 入口")
    }

    async fn build_with_context(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<BuiltApks> {
        Ok(self.record(request, cancel, context))
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}

/// 不实现新增方法，证明默认入口不会增加旧适配器的必需实现。
#[derive(Default)]
struct LegacyBuilder(Recorder);

#[async_trait]
impl BundleBuilder for LegacyBuilder {
    async fn build(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
    ) -> Result<BuiltApks> {
        Ok(self.0.record(request, cancel, ExecutionContext::default()))
    }
}

#[tokio::test]
async fn context_preserves_both_modes_original_deadline_token_and_output() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    let context = context();
    let parent = CancellationToken::new();
    let cancel = parent.child_token();
    for mode in [BuildMode::Default, BuildMode::Universal] {
        let result = executor
            .execute_with_context(BUILD, input(mode), cancel.clone(), context)
            .await
            .unwrap();
        assert_eq!(result, serde_json::to_value(built(&request(mode))).unwrap());
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    for (call, mode) in calls.iter().zip([BuildMode::Default, BuildMode::Universal]) {
        assert_eq!(call.request.artifact_id, ID);
        assert_eq!(call.request.mode, mode);
        assert_eq!(call.context.deadline, context.deadline, "原截止点不得刷新");
        assert!(!call.cancel.is_cancelled());
    }
    parent.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
}

#[tokio::test]
async fn old_execute_delegates_to_context_entry_without_a_deadline() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    let result = executor
        .execute(BUILD, input(BuildMode::Default), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result,
        serde_json::to_value(built(&request(BuildMode::Default))).unwrap()
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].context.deadline.is_none());
}

#[tokio::test]
async fn default_context_method_supports_a_legacy_only_builder() {
    let legacy = Arc::new(LegacyBuilder::default());
    let executor = BundleOperations(legacy.clone());
    let cancel = CancellationToken::new();
    for mode in [BuildMode::Default, BuildMode::Universal] {
        let result = executor
            .execute_with_context(BUILD, input(mode), cancel.clone(), context())
            .await
            .unwrap();
        assert_eq!(result, serde_json::to_value(built(&request(mode))).unwrap());
    }
    let calls = legacy.0.calls();
    assert_eq!(calls.len(), 2);
    for (call, mode) in calls.iter().zip([BuildMode::Default, BuildMode::Universal]) {
        assert_eq!(call.request.artifact_id, ID);
        assert_eq!(call.request.mode, mode);
    }
    cancel.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
    assert!(!executor.has_unresolved_resources());
}

#[tokio::test]
async fn cancelled_or_expired_preflight_makes_zero_build_calls() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        matches!(
            executor
                .execute_with_context(BUILD, json!({}), cancel, context())
                .await,
            Err(Error::Cancelled)
        ),
        "取消预检必须先于请求转换"
    );
    assert!(
        matches!(
            executor
                .execute_with_context(
                    BUILD,
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
    for mode in [BuildMode::Default, BuildMode::Universal] {
        for deadline in [None, context().deadline] {
            let cancel = CancellationToken::new();
            cancel.cancel();
            assert!(matches!(
                executor
                    .execute_with_context(BUILD, input(mode), cancel, ExecutionContext { deadline })
                    .await,
                Err(Error::Cancelled)
            ));
        }
        for cancelled in [false, true] {
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            let due = ExecutionContext {
                deadline: Some(Instant::now() - Duration::from_secs(1)),
            };
            assert!(
                matches!(
                    executor
                        .execute_with_context(BUILD, input(mode), cancel, due)
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
async fn invalid_requests_still_fail_before_build_calls() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    for invalid in [
        json!({}),
        json!([]),
        json!({"artifact_id": ID, "mode": "unsupported"}),
        json!({"artifact_id": "not-a-uuid", "mode": "default"}),
        json!({"artifact_id": ID, "mode": "default", "tool": "caller-choice"}),
    ] {
        assert!(matches!(
            executor
                .execute_with_context(BUILD, invalid, CancellationToken::new(), context())
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn unknown_operation_remains_before_budget_cancel_and_input_checks() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    for deadline in [
        None,
        context().deadline,
        Some(Instant::now() - Duration::from_secs(1)),
    ] {
        for cancelled in [false, true] {
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            let result = executor
                .execute_with_context(
                    "unknown.bundle",
                    json!({}),
                    cancel,
                    ExecutionContext { deadline },
                )
                .await;
            assert!(matches!(result, Err(Error::NotFound(id)) if id == "unknown.bundle"));
        }
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        executor.execute("unknown.bundle", json!({}), cancel).await,
        Err(Error::NotFound(id)) if id == "unknown.bundle"
    ));
    assert!(recorder.calls().is_empty());
}

#[test]
fn unresolved_resources_are_forwarded_live() {
    let recorder = Arc::new(Recorder::default());
    let executor = BundleOperations(recorder.clone());
    assert!(!executor.has_unresolved_resources());
    recorder.unresolved.store(true, Ordering::SeqCst);
    assert!(executor.has_unresolved_resources());
    recorder.unresolved.store(false, Ordering::SeqCst);
    assert!(!executor.has_unresolved_resources());
}
