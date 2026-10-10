use super::*;
use serde_json::json;
fn fixture() -> (sdk::DeviceProviderAccess, Vec<Operation>) {
    let access=serde_json::from_value(json!({"api_version":1,"platform":"模拟平台","discover_operation":"discover","capabilities":[{"id":"echo","version":1,"operation":"echo","scope":"device","access":"write"}]})).unwrap();
    let operations = vec![
        Operation {
            id: "plugin.test.discover".into(),
            title: "发现".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        },
        Operation {
            id: "plugin.test.echo".into(),
            title: "业务必填".into(),
            input_schema: json!({"type":"object","properties":{"device_id":{"type":"string","enum":["real-id"]},"input":{"type":"object","required":["artifact_id"],"properties":{"artifact_id":{"type":"string"}}}},"required":["device_id","input"],"additionalProperties":false}),
            execution: None,
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
    for schema in [
        json!({"type":"object","required":["unexpected"]}),
        json!({"type":"array"}),
        json!(true),
    ] {
        let mut invalid = operations.clone();
        invalid[0].input_schema = schema;
        assert!(matches!(
            definition("test", &access, &invalid),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn budgets_require_api_two_or_three_and_keep_legacy_defaults() {
    let (mut access, operations) = fixture();
    let legacy = definition("test", &access, &operations).unwrap();
    assert_eq!(
        legacy.capabilities[0].execution_timeout().as_millis(),
        30_000
    );
    assert!(
        serde_json::to_value(&access).unwrap()["capabilities"][0]
            .get("execution_timeout_ms")
            .is_none()
    );
    access.capabilities[0].execution_timeout_ms = Some(120_000);
    assert!(matches!(
        definition("test", &access, &operations),
        Err(Error::Invalid(_))
    ));
    for api in [2, 3] {
        access.api_version = api;
        for timeout in [1, 120_000] {
            access.capabilities[0].execution_timeout_ms = Some(timeout);
            let mapped = definition("test", &access, &operations).unwrap();
            assert_eq!(mapped.api_version, api);
            assert_eq!(
                mapped.capabilities[0].execution_timeout().as_millis(),
                u128::from(timeout)
            );
        }
        for invalid in [0, 120_001, u64::MAX] {
            access.capabilities[0].execution_timeout_ms = Some(invalid);
            assert!(matches!(
                definition("test", &access, &operations),
                Err(Error::Invalid(_))
            ));
        }
        access.capabilities[0].execution_timeout_ms = None;
        assert_eq!(
            definition("test", &access, &operations)
                .unwrap()
                .capabilities[0]
                .execution_timeout()
                .as_millis(),
            30_000
        );
        let mut explicit = serde_json::to_value(&access).unwrap();
        explicit["capabilities"][0]["execution_timeout_ms"] = serde_json::Value::Null;
        let null: sdk::DeviceProviderAccess = serde_json::from_value(explicit).unwrap();
        assert_eq!(
            definition("test", &null, &operations).unwrap().capabilities[0]
                .execution_timeout()
                .as_millis(),
            30_000
        );
    }
    for unsupported in [0, 4] {
        access.api_version = unsupported;
        assert!(matches!(
            definition("test", &access, &operations),
            Err(Error::Invalid(_))
        ));
    }
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

#[test]
fn discovery_raw_state_missing_and_null_remain_omitted_in_all_versions() {
    for api in [1, 2, 3] {
        let (mut access, operations) = fixture();
        access.api_version = api;
        let definition = definition("test", &access, &operations).unwrap();
        let device = json!({"id":"real-id","state":"unknown","capabilities":[]});
        let output = discovery(&definition, json!([device.clone()])).unwrap();
        assert!(output[0].get("raw_state").is_none());
        let mut explicit = device;
        explicit["raw_state"] = serde_json::Value::Null;
        let output = discovery(&definition, json!([explicit])).unwrap();
        assert!(output[0].get("raw_state").is_none());

        if api != 3 {
            for raw in ["", " ", "recovery", "Vendor.Mode"] {
                let value =
                    json!([{"id":"real-id","state":"unknown","raw_state":raw,"capabilities":[]}]);
                assert!(matches!(
                    discovery(&definition, value),
                    Err(Error::Dependency(_))
                ));
            }
        }
    }
}

#[test]
fn api_three_discovery_preserves_raw_text_without_changing_normalized_state() {
    let (mut access, operations) = fixture();
    access.api_version = 3;
    let definition = definition("test", &access, &operations).unwrap();
    for raw in [
        " Vendor.Recovery 模式 ".to_owned(),
        "sideload".to_owned(),
        "bootloader".to_owned(),
        "x".repeat(100),
        format!("{}a", "界".repeat(33)),
    ] {
        let value = json!([{"id":"real-id","state":"unknown","raw_state":raw,"capabilities":[]}]);
        assert_eq!(discovery(&definition, value.clone()).unwrap(), value);
    }
}

#[test]
fn api_three_bad_raw_state_rejects_the_entire_discovery_with_dependency_error() {
    let (mut access, operations) = fixture();
    access.api_version = 3;
    let definition = definition("test", &access, &operations).unwrap();
    for invalid in [
        json!(""),
        json!(" \u{3000}"),
        json!("raw\nstate"),
        json!("raw\u{0085}state"),
        json!("x".repeat(101)),
        json!(format!("{}ab", "界".repeat(33))),
        json!(1),
        json!(true),
        json!([]),
        json!({}),
    ] {
        let valid =
            json!({"id":"real-id","state":"unknown","raw_state":"Vendor.Mode","capabilities":[]});
        let invalid = json!({"id":"other","state":"unknown","raw_state":invalid,"capabilities":[]});
        assert!(matches!(
            discovery(&definition, json!([valid, invalid])),
            Err(Error::Dependency(_))
        ));
    }
}
