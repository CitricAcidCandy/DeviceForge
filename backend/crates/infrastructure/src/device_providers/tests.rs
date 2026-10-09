use super::*;
use serde_json::json;
fn fixture() -> (sdk::DeviceProviderAccess, Vec<Operation>) {
    let access=serde_json::from_value(json!({"api_version":1,"platform":"模拟平台","discover_operation":"discover","capabilities":[{"id":"echo","version":1,"operation":"echo","scope":"device","access":"write"}]})).unwrap();
    let operations = vec![
        Operation {
            id: "plugin.test.discover".into(),
            title: "发现".into(),
            input_schema: json!({"type":"object"}),
        },
        Operation {
            id: "plugin.test.echo".into(),
            title: "业务必填".into(),
            input_schema: json!({"type":"object","properties":{"device_id":{"type":"string","enum":["real-id"]},"input":{"type":"object","required":["artifact_id"],"properties":{"artifact_id":{"type":"string"}}}},"required":["device_id","input"],"additionalProperties":false}),
        },
    ];
    (access, operations)
}
#[test]
fn declaration_maps_namespace_without_requiring_empty_business_input() {
    let (access, operations) = fixture();
    let mapped = definition("test", &access, &operations).unwrap();
    assert_eq!(mapped.capabilities[0].operation, "plugin.test.echo");
    let mut invalid = access.clone();
    invalid.capabilities[0].operation = "missing".into();
    assert!(matches!(
        definition("test", &invalid, &operations),
        Err(Error::Invalid(_))
    ));
    for (field, bad_type) in [
        ("input", json!("string")),
        ("device_id", json!(["null", "integer"])),
    ] {
        let mut bad = operations.clone();
        bad[1].input_schema["properties"][field]["type"] = bad_type;
        assert!(matches!(
            definition("test", &access, &bad),
            Err(Error::Invalid(_))
        ));
    }
    let mut invalid = access.clone();
    invalid.capabilities[0].version = 0;
    assert!(matches!(
        definition("test", &invalid, &operations),
        Err(Error::Invalid(_))
    ));
    let mut operations = operations;
    operations[0].input_schema = json!({"type":"object","required":["unexpected"]});
    assert!(matches!(
        definition("test", &access, &operations),
        Err(Error::Invalid(_))
    ));
}
#[test]
fn discovery_rejects_duplicate_unknown_state_undeclared_capability_and_limits() {
    let (access, operations) = fixture();
    let definition = definition("test", &access, &operations).unwrap();
    let device = json!({"id":"real-id","state":"online","model":null,"capabilities":[{"id":"echo","version":1,"available":true}]});
    assert!(discovery(&definition, json!([device.clone()])).is_ok());
    let mut unknown = device.clone();
    unknown["capabilities"][0]["id"] = json!("unknown");
    let mut state = device.clone();
    state["state"] = json!("bad");
    for value in [
        json!([device.clone(), device.clone()]),
        json!([unknown]),
        json!([state]),
        json!(vec![device; 129]),
        json!({"result":[]}),
    ] {
        assert!(matches!(
            discovery(&definition, value),
            Err(Error::Dependency(_))
        ));
    }
}
