use apk_plugin_sdk::{Manifest, services::*};
use serde_json::json;

#[test]
fn exact_string_versions_roundtrip_without_numeric_coercion() {
    for version in ["1", "1.0", "1.0.0", "v2-preview"] {
        let reference: ServiceRef =
            serde_json::from_value(json!({"id":"demo.echo","version":version})).unwrap();
        reference.validate().unwrap();
        assert_eq!(serde_json::to_value(reference).unwrap()["version"], version);
    }
    for version in [json!(1), json!(1.0), json!(null), json!(""), json!("   ")] {
        assert!(
            serde_json::from_value::<ServiceRef>(json!({"id":"demo.echo","version":version}))
                .is_err()
        );
    }
    assert_ne!(
        ServiceRef {
            id: "demo.echo".into(),
            version: "1".into()
        },
        ServiceRef {
            id: "demo.echo".into(),
            version: "1.0".into()
        }
    );
}

#[test]
fn legacy_manifests_omit_services_and_protocol_six_is_explicit() {
    for protocol_version in [1, 2, 3, 4] {
        let manifest: Manifest = serde_json::from_value(json!({"id":"old","version":"1","protocol_version":protocol_version,"executable":"fixture","operations":[]})).unwrap();
        assert!(manifest.services.is_none());
        assert!(
            serde_json::to_value(manifest)
                .unwrap()
                .get("services")
                .is_none()
        );
    }
    let mut ready = json!({"command":"ready","protocol_version":6,"request_id":"root"});
    let frame: ServiceFrame = serde_json::from_value(ready.clone()).unwrap();
    frame.validate("root").unwrap();
    assert!(frame.validate("another").is_err());
    ready["protocol_version"] = json!(4);
    assert!(
        serde_json::from_value::<ServiceFrame>(ready)
            .unwrap()
            .validate("root")
            .is_err()
    );
}

#[test]
fn reverse_frames_reject_bad_identity_budget_unknown_fields_and_preserve_null() {
    let valid = json!({"command":"service_call","protocol_version":6,"request_id":"root","call_id":"child","service":{"id":"demo.echo","version":"1.0"},"input":{}});
    serde_json::from_value::<ServiceFrame>(valid.clone())
        .unwrap()
        .validate("root")
        .unwrap();
    for (field, value) in [
        ("protocol_version", json!(5)),
        ("request_id", json!("other")),
        ("call_id", json!("")),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(
            serde_json::from_value::<ServiceFrame>(invalid)
                .unwrap()
                .validate("root")
                .is_err()
        );
    }
    let mut unknown = valid;
    unknown["url"] = json!("http://localhost");
    assert!(serde_json::from_value::<ServiceFrame>(unknown).is_err());
    let start: ServiceFrame = serde_json::from_value(json!({"command":"start","protocol_version":6,"request_id":"root","remaining_timeout_ns":3_600_000_000_001u64})).unwrap();
    assert!(start.validate("root").is_err());
    let outcome: ServiceOutcome =
        serde_json::from_value(json!({"status":"succeeded","result":null})).unwrap();
    assert!(matches!(
        outcome,
        ServiceOutcome::Succeeded {
            result: serde_json::Value::Null
        }
    ));
    assert!(serde_json::from_value::<ServiceOutcome>(json!({"status":"succeeded"})).is_err());
}
