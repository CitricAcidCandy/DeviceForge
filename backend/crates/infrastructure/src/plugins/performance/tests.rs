use crate::plugins::ProcessPlugin;
use apk_domain::{Error, Executor};
use apk_plugin_sdk::Manifest;
use serde_json::{Value, json};

fn device_manifest() -> Value {
    json!({"id":"fixture","version":"1","protocol_version":4,"executable":std::env::current_exe().unwrap(),
        "performance":{"api_version":2,"sample_operation":"sample","device_capability":{"id":"sample","version":1}},
        "artifacts":{"input_pointers":["/input/artifact_id"],"outputs":true},
        "devices":{"api_version":3,"platform":"fixture","discover_operation":"discover","capabilities":[
            {"id":"sample","version":1,"operation":"sample","scope":"device","access":"read","execution_timeout_ms":10000}]},
        "operations":[{"name":"discover","title":"发现","input_schema":{"type":"object","additionalProperties":false}},
            {"name":"sample","title":"采样","input_schema":{"type":"object","additionalProperties":false,
                "properties":{"device_id":{"type":"string"},"input":{"type":"object","additionalProperties":false,
                    "properties":{"package":{"type":"string"}},"required":["package"]}},"required":["device_id","input"]}}]})
}

fn plugin(value: Value) -> apk_domain::Result<ProcessPlugin> {
    let manifest: Manifest =
        serde_json::from_value(value).map_err(|error| Error::Invalid(error.to_string()))?;
    ProcessPlugin::new(manifest)
}

#[test]
fn device_source_maps_full_ids_and_allows_other_contributions_artifacts() {
    let plugin = plugin(device_manifest()).unwrap();
    let source = plugin.performance_source().unwrap();
    assert_eq!(source.operation, "plugin.fixture.sample");
    assert_eq!(source.api_version, 2);
    assert_eq!(source.device_capability.unwrap().version, 1);
    assert!(plugin.manifest().artifacts.as_ref().unwrap().outputs);
}

#[test]
fn source_rejects_wrong_protocol_provider_binding_and_access_before_publication() {
    for (pointer, invalid) in [
        ("/protocol_version", json!(2)),
        ("/protocol_version", json!(3)),
        ("/devices/api_version", json!(2)),
        ("/devices/capabilities/0/version", json!(2)),
        ("/devices/capabilities/0/access", json!("write")),
        ("/performance/sample_operation", json!("absent")),
        (
            "/operations/1/input_schema/properties/input/additionalProperties",
            json!(true),
        ),
    ] {
        let mut manifest = device_manifest();
        *manifest.pointer_mut(pointer).unwrap() = invalid;
        assert!(
            matches!(plugin(manifest), Err(Error::Invalid(_))),
            "{pointer}"
        );
    }
}

#[test]
fn artifact_selectors_must_be_disjoint_from_every_sample_input_prefix() {
    for pointer in [
        "/device_id",
        "/device_id/deeper",
        "/input",
        "/input/package",
        "/input/package/deeper",
    ] {
        let mut manifest = device_manifest();
        manifest["artifacts"]["input_pointers"] = json!([pointer]);
        assert!(
            matches!(plugin(manifest), Err(Error::Invalid(_))),
            "{pointer}"
        );
    }
    for field in ["device_id", "input"] {
        let mut manifest = device_manifest();
        manifest["artifacts"]["input_fields"] = json!([field]);
        assert!(matches!(plugin(manifest), Err(Error::Invalid(_))));
    }
    for pointer in [
        "/artifact_id",
        "/input/artifact_id",
        "/input/artifact_id/deeper",
        "/escaped~1field",
    ] {
        let mut manifest = device_manifest();
        manifest["artifacts"]["input_pointers"] = json!([pointer]);
        assert!(plugin(manifest).is_ok(), "{pointer}");
    }
}

#[test]
fn legacy_declaration_keeps_original_wire_shape_and_whole_plugin_artifact_gate() {
    let mut value = device_manifest();
    value["protocol_version"] = json!(2);
    value.as_object_mut().unwrap().remove("devices");
    value.as_object_mut().unwrap().remove("artifacts");
    value["performance"] = json!({"sample_operation":"sample","fps":false});
    let original = value["performance"].clone();
    let legacy = plugin(value.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&legacy.manifest().performance).unwrap(),
        original
    );
    assert!(
        legacy
            .performance_source()
            .unwrap()
            .device_capability
            .is_none()
    );
    value["artifacts"] = json!({"input_pointers":["/unused"],"outputs":false});
    assert!(matches!(plugin(value), Err(Error::Invalid(_))));
}
