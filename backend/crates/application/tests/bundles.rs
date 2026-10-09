use apk_application::bundles::BundleOperations;
use apk_domain::{
    Error, Executor, Result,
    bundles::{BuildApksRequest, BuiltApks, BundleBuilder},
};
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;
struct Probe(AtomicUsize);
#[async_trait]
impl BundleBuilder for Probe {
    async fn build(&self, _: BuildApksRequest, _: CancellationToken) -> Result<BuiltApks> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(Error::Dependency("模拟端口已接收请求".into()))
    }
}
#[tokio::test]
async fn generated_schema_and_execution_reject_server_paths_and_invalid_modes() {
    let probe = Arc::new(Probe(AtomicUsize::new(0)));
    let operations = BundleOperations(probe.clone());
    let validator = jsonschema::validator_for(&operations.operations()[0].input_schema).unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    for input in [
        json!({"artifact_id":"bad", "mode":"default"}),
        json!({"artifact_id":id}),
        json!({"artifact_id":id,"mode":"custom"}),
        json!({"artifact_id":id,"mode":"default","keystore":"server.jks"}),
        json!({"artifact_id":id,"mode":"universal","executable":"server.exe"}),
    ] {
        assert!(!validator.is_valid(&input));
        assert!(matches!(
            operations
                .execute(
                    "android.package.build_apks",
                    input,
                    CancellationToken::new()
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(probe.0.load(Ordering::SeqCst), 0);
    for mode in ["default", "universal"] {
        let input = json!({"artifact_id":id,"mode":mode});
        assert!(validator.is_valid(&input));
        assert!(matches!(
            operations
                .execute(
                    "android.package.build_apks",
                    input,
                    CancellationToken::new()
                )
                .await,
            Err(Error::Dependency(_))
        ));
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        operations
            .execute("android.package.build_apks", json!({}), cancel)
            .await,
        Err(Error::Cancelled)
    ));
    assert_eq!(probe.0.load(Ordering::SeqCst), 2);
}
