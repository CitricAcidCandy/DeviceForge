use super::ReverseOperations;
use apk_domain::{
    Error, ExecutionContext, Executor, Result,
    artifacts::Artifact,
    reverse::{DecodedPackage, PackageReverse, SdkFinding, SdkRule, SdkScan},
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
const DECODE: &str = "android.package.decode";
const SCAN: &str = "android.package.scan_sdks";

#[derive(Clone)]
struct Call {
    operation: &'static str,
    id: String,
    rules: Vec<SdkRule>,
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
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) {
        self.calls.lock().expect("调用记录锁").push(Call {
            operation,
            id: id.into(),
            rules,
            cancel,
            context,
        });
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("调用记录锁").clone()
    }
}

fn rules() -> Vec<SdkRule> {
    vec![
        SdkRule {
            name: "完整类规则".into(),
            package_path: "example.sdk".into(),
            class_name: Some("Entry".into()),
        },
        SdkRule {
            name: "仅包路径规则".into(),
            package_path: "example.path".into(),
            class_name: None,
        },
    ]
}

fn decoded(id: &str) -> DecodedPackage {
    DecodedPackage {
        source_artifact_id: id.into(),
        artifact: Artifact {
            id: "b4267a20-79b1-4b07-a05a-a7de89a38397".into(),
            filename: "decoded.zip".into(),
            media_type: "application/zip".into(),
            size: 42,
            sha256: "ab".repeat(32),
            created_at: 123,
        },
        files: 3,
        unpacked_size: 73,
    }
}

fn scanned(id: &str, rules: Vec<SdkRule>) -> SdkScan {
    SdkScan {
        artifact_id: id.into(),
        findings: rules
            .into_iter()
            .map(|rule| SdkFinding {
                class_found: rule.class_name.as_ref().map(|_| true),
                rule,
                package_found: true,
                evidence: vec!["smali/example/sdk/Entry.smali".into()],
            })
            .collect(),
    }
}

fn cases() -> [(&'static str, Value); 2] {
    [
        (DECODE, json!({"artifact_id": ID})),
        (SCAN, json!({"artifact_id": ID, "rules": rules()})),
    ]
}

fn expected(operation: &str) -> Value {
    match operation {
        DECODE => serde_json::to_value(decoded(ID)).unwrap(),
        SCAN => serde_json::to_value(scanned(ID, rules())).unwrap(),
        _ => panic!("只允许两个反编译域测试操作"),
    }
}

fn context() -> ExecutionContext {
    ExecutionContext {
        deadline: Some(Instant::now() + Duration::from_secs(300)),
    }
}

#[async_trait]
impl PackageReverse for Recorder {
    async fn decode(&self, _: &str, _: CancellationToken) -> Result<DecodedPackage> {
        panic!("应用必须调用反编译 context 入口")
    }

    async fn scan_sdks(&self, _: &str, _: Vec<SdkRule>, _: CancellationToken) -> Result<SdkScan> {
        panic!("应用必须调用检测 context 入口")
    }

    async fn decode_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<DecodedPackage> {
        self.record(DECODE, id, vec![], cancel, context);
        Ok(decoded(id))
    }

    async fn scan_sdks_with_context(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<SdkScan> {
        self.record(SCAN, id, rules.clone(), cancel, context);
        Ok(scanned(id, rules))
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}

/// 旧仅实现者不覆盖新增入口或资源观测。
#[derive(Default)]
struct LegacyReverse(Recorder);

#[async_trait]
impl PackageReverse for LegacyReverse {
    async fn decode(&self, id: &str, cancel: CancellationToken) -> Result<DecodedPackage> {
        self.0
            .record(DECODE, id, vec![], cancel, ExecutionContext::default());
        Ok(decoded(id))
    }

    async fn scan_sdks(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
    ) -> Result<SdkScan> {
        self.0
            .record(SCAN, id, rules.clone(), cancel, ExecutionContext::default());
        Ok(scanned(id, rules))
    }
}

#[tokio::test]
async fn both_context_paths_preserve_deadline_rules_token_and_results() {
    let recorder = Arc::new(Recorder::default());
    let executor = ReverseOperations(recorder.clone());
    let context = context();
    let parent = CancellationToken::new();
    let cancel = parent.child_token();
    for (operation, input) in cases() {
        let result = executor
            .execute_with_context(operation, input, cancel.clone(), context)
            .await
            .unwrap();
        assert_eq!(result, expected(operation));
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    for (call, (operation, _)) in calls.iter().zip(cases()) {
        assert_eq!(call.operation, operation);
        assert_eq!(call.id, ID);
        assert_eq!(call.context.deadline, context.deadline, "原截止点不得刷新");
        assert!(!call.cancel.is_cancelled());
    }
    assert!(calls[0].rules.is_empty());
    assert_eq!(
        serde_json::to_value(&calls[1].rules).unwrap(),
        serde_json::to_value(rules()).unwrap()
    );
    parent.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
}

#[tokio::test]
async fn old_execute_uses_context_entries_with_no_deadline() {
    let recorder = Arc::new(Recorder::default());
    let executor = ReverseOperations(recorder.clone());
    for (operation, input) in cases() {
        let result = executor
            .execute(operation, input, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result, expected(operation));
    }
    let calls = recorder.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|call| call.context.deadline.is_none()));
}

#[tokio::test]
async fn default_context_entries_support_a_legacy_only_reverse_adapter() {
    let legacy = Arc::new(LegacyReverse::default());
    let executor = ReverseOperations(legacy.clone());
    let cancel = CancellationToken::new();
    for (operation, input) in cases() {
        let result = executor
            .execute_with_context(operation, input, cancel.clone(), context())
            .await
            .unwrap();
        assert_eq!(result, expected(operation));
    }
    let calls = legacy.0.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].operation, DECODE);
    assert_eq!(calls[1].operation, SCAN);
    assert!(calls.iter().all(|call| call.id == ID));
    assert_eq!(
        serde_json::to_value(&calls[1].rules).unwrap(),
        serde_json::to_value(rules()).unwrap()
    );
    cancel.cancel();
    assert!(calls.iter().all(|call| call.cancel.is_cancelled()));
    assert!(!executor.has_unresolved_resources());
}

#[tokio::test]
async fn cancelled_or_expired_preflight_makes_zero_reverse_calls() {
    let recorder = Arc::new(Recorder::default());
    let executor = ReverseOperations(recorder.clone());
    for operation in [DECODE, SCAN] {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            matches!(
                executor
                    .execute_with_context(operation, json!({}), cancel, context())
                    .await,
                Err(Error::Cancelled)
            ),
            "取消预检必须先于产物 ID 转换"
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
            "到期预检必须先于产物 ID 转换"
        );
    }
    for (operation, input) in cases() {
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
async fn malformed_inputs_keep_invalid_errors_and_never_reach_reverse_ports() {
    let recorder = Arc::new(Recorder::default());
    let executor = ReverseOperations(recorder.clone());
    for (operation, input, message) in [
        (DECODE, json!({}), "缺少产物 ID"),
        (SCAN, json!({"artifact_id": 3}), "缺少产物 ID"),
        (DECODE, json!([]), "缺少产物 ID"),
        (SCAN, json!({"artifact_id": ID}), "缺少 SDK 规则"),
    ] {
        let result = executor
            .execute_with_context(operation, input, CancellationToken::new(), context())
            .await;
        assert!(matches!(result, Err(Error::Invalid(actual)) if actual == message));
    }
    for invalid_rules in [
        json!(null),
        json!({}),
        json!([{"name":"缺路径"}]),
        json!([{"name":"规则","package_path":"example.sdk","class_name":3}]),
        json!([{"name":"规则","package_path":"example.sdk","unexpected":true}]),
    ] {
        assert!(matches!(
            executor
                .execute_with_context(
                    SCAN,
                    json!({"artifact_id": ID, "rules": invalid_rules}),
                    CancellationToken::new(),
                    context()
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn unknown_operation_keeps_budget_then_artifact_id_then_match_order() {
    let recorder = Arc::new(Recorder::default());
    let executor = ReverseOperations(recorder.clone());
    let unknown = "unknown.reverse";
    let result = executor
        .execute(unknown, json!({}), CancellationToken::new())
        .await;
    assert!(matches!(result, Err(Error::Invalid(message)) if message == "缺少产物 ID"));
    let result = executor
        .execute_with_context(
            unknown,
            json!({"artifact_id": ID}),
            CancellationToken::new(),
            context(),
        )
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
    let executor = ReverseOperations(recorder.clone());
    assert!(!executor.has_unresolved_resources());
    recorder.unresolved.store(true, Ordering::SeqCst);
    assert!(executor.has_unresolved_resources());
    recorder.unresolved.store(false, Ordering::SeqCst);
    assert!(!executor.has_unresolved_resources());
}
