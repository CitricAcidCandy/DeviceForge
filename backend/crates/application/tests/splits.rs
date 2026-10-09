use apk_application::splits::SplitOperations;
use apk_domain::{
    Error, Executor, Result,
    splits::{
        ApksInstalled, ExtractSplitsRequest, ExtractedSplits, InstallApksRequest, SplitPackages,
    },
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
impl SplitPackages for Probe {
    async fn extract(
        &self,
        _: ExtractSplitsRequest,
        _: CancellationToken,
    ) -> Result<ExtractedSplits> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(Error::Dependency("已调用端口".into()))
    }
    async fn install(&self, _: InstallApksRequest, _: CancellationToken) -> Result<ApksInstalled> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(Error::Dependency("已调用端口".into()))
    }
}
#[tokio::test]
async fn typed_spec_and_device_validation_match_the_public_schema() {
    let probe = Arc::new(Probe(AtomicUsize::new(0)));
    let operations = SplitOperations(probe.clone());
    let registered = operations.operations();
    let extract = jsonschema::validator_for(&registered[0].input_schema).unwrap();
    let install = jsonschema::validator_for(&registered[1].input_schema).unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let valid = json!({"artifact_id":id,"device_spec":{"supported_abis":["arm64-v8a"],"supported_locales":["zh_CN"],"screen_density":480,"sdk_version":35}});
    assert!(extract.is_valid(&valid));
    assert!(matches!(
        operations
            .execute(
                "android.package.extract_splits",
                valid.clone(),
                CancellationToken::new()
            )
            .await,
        Err(Error::Dependency(_))
    ));
    for (field, value) in [
        ("supported_abis", json!([])),
        ("supported_abis", json!(["arm64-v8a", "arm64-v8a"])),
        ("supported_abis", json!(["../bad"])),
        ("supported_abis", json!(["a".repeat(81)])),
        ("supported_locales", json!([])),
        ("supported_locales", json!(["en", "en"])),
        ("screen_density", json!(0)),
        ("sdk_version", json!(10001)),
    ] {
        let mut input = valid.clone();
        input["device_spec"][field] = value;
        assert!(!extract.is_valid(&input), "{input}");
        assert!(matches!(
            operations
                .execute(
                    "android.package.extract_splits",
                    input,
                    CancellationToken::new()
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }
    for input in [
        json!({"artifact_id":id,"device_id":"-s"}),
        json!({"artifact_id":id,"device_id":"ok","adb":"server.exe"}),
        json!({"artifact_id":"bad","device_id":"ok"}),
    ] {
        assert!(!install.is_valid(&input));
        assert!(matches!(
            operations
                .execute("android.app.install_apks", input, CancellationToken::new())
                .await,
            Err(Error::Invalid(_))
        ));
    }
    let input = json!({"artifact_id":id,"device_id":"192.168.1.2:5555"});
    assert!(install.is_valid(&input));
    assert!(matches!(
        operations
            .execute("android.app.install_apks", input, CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        operations
            .execute("android.app.install_apks", json!({}), cancel)
            .await,
        Err(Error::Cancelled)
    ));
    assert_eq!(probe.0.load(Ordering::SeqCst), 2);
}
