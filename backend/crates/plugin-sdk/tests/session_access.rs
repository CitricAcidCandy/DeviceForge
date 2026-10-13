use apk_plugin_sdk::{Manifest, SessionAccess, packages::PortableServerManifest};
use serde_json::{Value, json};

fn operations() -> Value {
    json!([{"name":"shell","title":"交互会话","input_schema":{"type":"object"}}])
}

fn sessions() -> Value {
    json!({"protocol_version":5,"operations":operations()})
}

#[test]
fn old_task_protocols_preserve_absent_session_field() {
    for version in 1..=4 {
        let original = json!({
            "id":"legacy", "version":"0.1.0", "protocol_version":version,
            "executable":"example", "args":[], "operations":[]
        });
        let manifest: Manifest = serde_json::from_value(original.clone()).unwrap();
        assert!(manifest.sessions.is_none());
        assert_eq!(serde_json::to_value(manifest).unwrap(), original);
    }
}

#[test]
fn explicit_null_sessions_are_omitted_on_serialization() {
    let original = json!({
        "id":"legacy", "version":"0.1.0", "protocol_version":4,
        "executable":"example", "operations":[], "sessions":null
    });
    let manifest: Manifest = serde_json::from_value(original).unwrap();
    assert!(manifest.sessions.is_none());
    assert!(
        serde_json::to_value(manifest)
            .unwrap()
            .get("sessions")
            .is_none()
    );
}

#[test]
fn independent_session_declaration_roundtrips_with_old_task_protocol() {
    let original = json!({
        "id":"interactive", "version":"0.1.0", "protocol_version":4,
        "executable":"example", "operations":[], "sessions":sessions()
    });
    let manifest: Manifest = serde_json::from_value(original).unwrap();
    manifest.sessions.as_ref().unwrap().validate().unwrap();
    let encoded = serde_json::to_value(manifest).unwrap();
    assert_eq!(encoded["protocol_version"], 4);
    assert_eq!(encoded["sessions"], sessions());
    assert_eq!(encoded["operations"], json!([]));
}

#[test]
fn portable_package_keeps_session_declaration_without_entry_paths() {
    let original = json!({
        "id":"interactive", "version":"0.1.0", "protocol_version":3,
        "operations":[], "sessions":sessions()
    });
    let manifest: PortableServerManifest = serde_json::from_value(original).unwrap();
    manifest.sessions.as_ref().unwrap().validate().unwrap();
    let encoded = serde_json::to_value(manifest).unwrap();
    assert_eq!(encoded["sessions"], sessions());
    assert!(encoded.get("executable").is_none());
    let legacy: PortableServerManifest = serde_json::from_value(json!({
        "id":"legacy", "version":"0.1.0", "protocol_version":1, "operations":[]
    }))
    .unwrap();
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("sessions")
            .is_none()
    );
}

#[test]
fn declaration_rejects_old_session_versions_and_unknown_capabilities() {
    for version in [0, 1, 2, 3, 4, 6] {
        let mut value = sessions();
        value["protocol_version"] = json!(version);
        assert!(serde_json::from_value::<SessionAccess>(value).is_err());
    }
    let mut value = sessions();
    value["pty"] = json!(true);
    assert!(serde_json::from_value::<SessionAccess>(value).is_err());
}

#[test]
fn direct_values_must_validate_nonempty_names_schema_and_budget() {
    let mut access: SessionAccess = serde_json::from_value(sessions()).unwrap();
    access.protocol_version = 4;
    assert!(access.validate().is_err());
    access.protocol_version = 5;
    access.operations[0].name = "Uppercase".into();
    assert!(access.validate().is_err());
    access.operations[0].name = "shell".into();
    access.operations[0].input_schema = json!({"type":"string"});
    assert!(access.validate().is_err());
    access.operations[0].input_schema = json!({"type":"object"});
    access.operations[0].execution = Some(apk_plugin_sdk::ExecutionBudget {
        api_version: 1,
        total_timeout_ms: 0,
    });
    assert!(access.validate().is_err());
    access.operations.clear();
    assert!(access.validate().is_err());
}

#[test]
fn duplicate_session_names_are_rejected() {
    let mut access: SessionAccess = serde_json::from_value(sessions()).unwrap();
    access.operations.push(access.operations[0].clone());
    assert!(access.validate().is_err());
}

#[test]
fn bounded_tail_is_explicit_and_default_keeps_old_wire_bytes() {
    let mut value = sessions();
    let complete: SessionAccess = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(complete).unwrap(), value);
    value["output_retention"] = json!("bounded_tail");
    let tail: SessionAccess = serde_json::from_value(value.clone()).unwrap();
    tail.validate().unwrap();
    assert_eq!(serde_json::to_value(tail).unwrap(), value);
    value["output_retention"] = json!("unlimited_history");
    assert!(serde_json::from_value::<SessionAccess>(value).is_err());
}
