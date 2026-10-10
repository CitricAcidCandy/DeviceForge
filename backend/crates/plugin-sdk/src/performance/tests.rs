//! 旧字节外形、显式设备绑定和错误声明边界；不访问宿主或设备。
use super::*;
use serde_json::{Value, json};

#[test]
fn legacy_declaration_omits_version_one_and_keeps_fps_default() {
    let original = json!({"sample_operation":"sample","fps":true});
    let access: PerformanceAccess = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(access.api_version, 1);
    assert!(access.device_capability.is_none());
    assert_eq!(serde_json::to_value(access).unwrap(), original);
    let access: PerformanceAccess =
        serde_json::from_value(json!({"sample_operation":"sample"})).unwrap();
    assert!(!access.fps);
    assert_eq!(
        serde_json::to_value(access).unwrap(),
        json!({"sample_operation":"sample","fps":false})
    );
    let access: PerformanceAccess = serde_json::from_value(
        json!({"api_version":1,"sample_operation":"sample","device_capability":null}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(access).unwrap(),
        json!({"sample_operation":"sample","fps":false})
    );
}

#[test]
fn device_declaration_roundtrips_exact_reference_and_explicit_version() {
    let value = json!({"api_version":2,"sample_operation":"performance.sample","fps":false,
        "device_capability":{"id":"performance.sample","version":1}});
    let access: PerformanceAccess = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(access.api_version, 2);
    assert_eq!(
        access.device_capability.as_ref().unwrap(),
        &PerformanceDeviceCapability {
            id: "performance.sample".into(),
            version: 1,
        }
    );
    assert_eq!(serde_json::to_value(access).unwrap(), value);
}

#[test]
fn declaration_versions_are_strict_unsigned_integers() {
    for invalid in [
        json!(0),
        json!(3),
        json!(-1),
        json!(1.5),
        json!("2"),
        json!(true),
        Value::Null,
        json!(u64::MAX),
    ] {
        assert!(
            serde_json::from_value::<PerformanceAccess>(
                json!({"api_version":invalid,"sample_operation":"sample"})
            )
            .is_err()
        );
    }
}

#[test]
fn binding_is_required_only_for_device_declarations() {
    for value in [
        json!({"api_version":2,"sample_operation":"sample"}),
        json!({"api_version":2,"sample_operation":"sample","device_capability":null}),
        json!({"sample_operation":"sample","device_capability":{"id":"sample","version":1}}),
        json!({"api_version":1,"sample_operation":"sample","device_capability":{"id":"sample","version":1}}),
    ] {
        assert!(serde_json::from_value::<PerformanceAccess>(value).is_err());
    }
}

#[test]
fn unknown_duplicate_and_malformed_fields_are_rejected() {
    for value in [
        json!({"sample_operation":"sample","shell":"adb"}),
        json!({"api_version":2,"sample_operation":"sample","device_capability":{"id":"sample","version":1,"provider_id":"other"}}),
        json!({"api_version":2,"sample_operation":"sample","device_capability":{"id":"sample"}}),
        json!({"api_version":2,"sample_operation":"sample","device_capability":{"version":1}}),
        json!({"sample_operation":"sample","fps":1}),
        json!({"api_version":2,"sample_operation":"sample","device_capability":[]}),
    ] {
        assert!(serde_json::from_value::<PerformanceAccess>(value).is_err());
    }
    for text in [
        r#"{"sample_operation":"sample","api_version":1,"api_version":1}"#,
        r#"{"api_version":2,"sample_operation":"sample","device_capability":{"id":"sample","id":"sample","version":1}}"#,
    ] {
        assert!(serde_json::from_str::<PerformanceAccess>(text).is_err());
    }
}

#[test]
fn binding_identifier_and_version_bounds_apply_to_json_and_literals() {
    for id in ["", "-sample", "设备", "sample/other", "sample\n"] {
        let binding = PerformanceDeviceCapability {
            id: id.into(),
            version: 1,
        };
        assert!(binding.validate().is_err());
        assert!(
            serde_json::from_value::<PerformanceAccess>(json!({"api_version":2,
                "sample_operation":"sample","device_capability":{"id":id,"version":1}}))
            .is_err()
        );
    }
    let boundary = PerformanceDeviceCapability {
        id: "a".repeat(100),
        version: u32::MAX,
    };
    assert!(boundary.validate().is_ok());
    assert!(
        PerformanceDeviceCapability {
            id: "a".repeat(101),
            ..boundary
        }
        .validate()
        .is_err()
    );
    for version in [json!(0), json!(-1), json!(1.5), json!("1"), Value::Null] {
        assert!(
            serde_json::from_value::<PerformanceAccess>(json!({"api_version":2,
                "sample_operation":"sample","device_capability":{"id":"sample","version":version}}))
            .is_err()
        );
    }
}

#[test]
fn programmatic_declaration_uses_the_same_version_binding_rules() {
    let mut access = PerformanceAccess {
        api_version: 1,
        sample_operation: "sample".into(),
        fps: false,
        device_capability: None,
    };
    assert!(access.validate().is_ok());
    access.api_version = 2;
    assert!(access.validate().is_err());
    access.device_capability = Some(PerformanceDeviceCapability {
        id: "sample".into(),
        version: 1,
    });
    assert!(access.validate().is_ok());
    access.api_version = 1;
    assert!(access.validate().is_err());
    access.api_version = 3;
    assert!(access.validate().is_err());
}
