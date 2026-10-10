use super::{InstallApksOperations, SplitOperations};
use apk_domain::{
    Error, ExecutionContext, Executor, Result,
    splits::{
        ApksInstalled, ExtractSplitsRequest, ExtractedSplits, InstallApksRequest, SplitPackages,
    },
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

const INSTALL: &str = "android.app.install_apks";
const ID: &str = "3b9e35ac-f5b1-422f-a9eb-5024e7f8f7be";

#[derive(Default)]
struct Installation {
    calls: Mutex<Vec<(InstallApksRequest, CancellationToken)>>,
    unresolved: AtomicBool,
    fail_cleanup: AtomicBool,
}

#[async_trait]
impl SplitPackages for Installation {
    async fn extract(
        &self,
        _: ExtractSplitsRequest,
        _: CancellationToken,
    ) -> Result<ExtractedSplits> {
        panic!("安装侧车不得调用离线提取端口")
    }

    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled> {
        self.calls
            .lock()
            .expect("安装记录锁")
            .push((request.clone(), cancel));
        if self.fail_cleanup.load(Ordering::SeqCst) {
            return Err(Error::CleanupFailed);
        }
        Ok(ApksInstalled {
            artifact_id: request.artifact_id,
            device_id: request.device_id,
            // 故意返回 false，验证应用不把领域结果自行改写成成功安装。
            installed: false,
        })
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::SeqCst)
    }
}

fn input() -> Value {
    json!({"artifact_id":ID,"device_id":"192.0.2.1:5555"})
}

#[test]
fn sidecar_registers_only_install_with_the_existing_schema() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    let declared = sidecar.operations();
    assert_eq!(declared.len(), 1);
    assert_eq!(declared[0].id, INSTALL);
    let legacy = SplitOperations(port)
        .operations()
        .into_iter()
        .find(|operation| operation.id == INSTALL)
        .expect("原安装贡献");
    assert_eq!(declared[0].input_schema, legacy.input_schema);
    assert_eq!(declared[0].title, legacy.title);
    assert_eq!(declared[0].execution, legacy.execution);
}

#[tokio::test]
async fn extraction_and_unknown_operations_never_reach_the_port() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    for operation in ["android.package.extract_splits", "unknown.split"] {
        assert!(matches!(
            sidecar.execute(operation, json!({}), CancellationToken::new()).await,
            Err(Error::NotFound(id)) if id == operation
        ));
    }
    assert!(port.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn valid_input_keeps_the_legacy_port_result_and_cancel_tree() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    let parent = CancellationToken::new();
    let expected = json!({"artifact_id":ID,"device_id":"192.0.2.1:5555","installed":false});
    let first = sidecar
        .execute(INSTALL, input(), parent.child_token())
        .await
        .unwrap();
    assert_eq!(first, expected);
    let second = sidecar
        .execute_with_context(
            INSTALL,
            input(),
            parent.child_token(),
            ExecutionContext {
                deadline: Some(std::time::Instant::now() + std::time::Duration::from_secs(300)),
            },
        )
        .await
        .unwrap();
    assert_eq!(second, expected);
    let calls = port.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    for (request, token) in calls.iter() {
        assert_eq!(serde_json::to_value(request).unwrap(), input());
        assert!(!token.is_cancelled());
    }
    parent.cancel();
    assert!(calls.iter().all(|(_, token)| token.is_cancelled()));
}

#[tokio::test]
async fn malformed_or_invalid_install_input_makes_zero_calls() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    for value in [
        json!([]),
        json!({}),
        json!({"artifact_id":ID}),
        json!({"artifact_id":null,"device_id":"serial"}),
        json!({"artifact_id":"not-a-uuid","device_id":"serial"}),
        json!({"artifact_id":ID,"device_id":"../escape"}),
        json!({"artifact_id":ID,"device_id":"serial","device_spec":{}}),
    ] {
        assert!(matches!(
            sidecar
                .execute(INSTALL, value, CancellationToken::new())
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(port.calls.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn preflight_cancel_and_deadline_win_before_decode_without_starting_install() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    for operation in [INSTALL, "android.package.extract_splits"] {
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            sidecar.execute(operation, json!({}), cancelled).await,
            Err(Error::Cancelled)
        ));
        for cancelled in [false, true] {
            let token = CancellationToken::new();
            if cancelled {
                token.cancel();
            }
            assert!(matches!(
                sidecar
                    .execute_with_context(
                        operation,
                        json!({}),
                        token,
                        ExecutionContext {
                            deadline: Some(tokio::time::Instant::now().into_std())
                        },
                    )
                    .await,
                Err(Error::Timeout)
            ));
        }
    }
    assert!(port.calls.lock().unwrap().is_empty());
}

#[test]
fn unresolved_observation_is_forwarded_from_the_shared_adapter() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    assert!(!sidecar.has_unresolved_resources());
    port.unresolved.store(true, Ordering::SeqCst);
    assert!(sidecar.has_unresolved_resources());
}

#[tokio::test]
async fn cleanup_failure_is_preserved_and_install_success_does_not_clear_observation() {
    let port = Arc::new(Installation::default());
    let sidecar = InstallApksOperations(port.clone());
    port.unresolved.store(true, Ordering::SeqCst);
    port.fail_cleanup.store(true, Ordering::SeqCst);
    assert!(matches!(
        sidecar
            .execute(INSTALL, input(), CancellationToken::new())
            .await,
        Err(Error::CleanupFailed)
    ));
    port.fail_cleanup.store(false, Ordering::SeqCst);
    assert!(
        sidecar
            .execute(INSTALL, input(), CancellationToken::new())
            .await
            .is_ok()
    );
    assert!(sidecar.has_unresolved_resources());
    assert_eq!(port.calls.lock().unwrap().len(), 2);
}
