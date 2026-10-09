use apk_application::device_input::InputOperations;
use apk_domain::{
    Error, Executor, Result,
    device_input::{DeviceInput, InputReceipt, InputRequest},
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
impl DeviceInput for Probe {
    async fn dispatch(&self, request: InputRequest, _: CancellationToken) -> Result<InputReceipt> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(InputReceipt {
            device_id: request.device_id,
            action: request.action.kind().into(),
            dispatched: true,
        })
    }
}
#[tokio::test]
async fn typed_input_schema_and_executor_enforce_the_same_boundaries() {
    let port = Arc::new(Probe(AtomicUsize::new(0)));
    let operations = InputOperations(port.clone());
    let schema = operations.operations().remove(0).input_schema;
    let validator = jsonschema::validator_for(&schema).unwrap();
    let input = json!({"device_id":"emulator-5554","action":{"kind":"text","text":"hello %s 'quoted'","enter":true}});
    assert!(validator.is_valid(&input));
    let result = operations
        .execute("android.input", input.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"device_id":"emulator-5554","action":"text","dispatched":true})
    );
    assert_eq!(port.0.load(Ordering::SeqCst), 1);
    for invalid in [
        json!({"device_id":"-s","action":{"kind":"tap","x":1,"y":2}}),
        json!({"device_id":"device","action":{"kind":"tap","x":32768,"y":2}}),
        json!({"device_id":"device","action":{"kind":"tap","x":-1,"y":2}}),
        json!({"device_id":"device","action":{"kind":"swipe","x1":0,"y1":0,"x2":1,"y2":1,"duration_ms":10001}}),
        json!({"device_id":"device","action":{"kind":"keyevent","key_code":65536}}),
        json!({"device_id":"device","action":{"kind":"text","text":"中文"}}),
        json!({"device_id":"device","action":{"kind":"text","text":"a\nb"}}),
        json!({"device_id":"device","action":{"kind":"text","text":""}}),
        json!({"device_id":"device","action":{"kind":"text","text":"a".repeat(1025)}}),
        json!({"device_id":"device","action":{"kind":"tap","x":1,"y":2,"shell":"reboot"}}),
        json!({"device_id":"device","action":{"kind":"tap","x":1,"y":2},"executable":"other"}),
    ] {
        assert!(!validator.is_valid(&invalid), "非法模式未被拦截：{invalid}");
        assert!(matches!(
            operations
                .execute("android.input", invalid, CancellationToken::new())
                .await,
            Err(Error::Invalid(_))
        ));
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        operations
            .execute("android.input", input.clone(), cancel)
            .await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        operations
            .execute("other.input", input, CancellationToken::new())
            .await,
        Err(Error::NotFound(_))
    ));
    assert_eq!(port.0.load(Ordering::SeqCst), 1);
}
