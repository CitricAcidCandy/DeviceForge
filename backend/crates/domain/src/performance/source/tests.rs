use super::PerformanceSourceRef;
use crate::performance::PerformanceSession;
use serde_json::{Value, json};

fn old_session() -> Value {
    json!({
        "id":"c760be9d-8c8f-4e03-b97d-cb2432091f49",
        "request":{
            "target":{"device_id":"fixture-1","package":"com.example.app"},
            "interval_ms":1000,"duration_secs":60
        },
        "state":"interrupted","revision":1,"samples":2,
        "started_at":1000,"updated_at":2000,"error":null
    })
}

fn independent_source() -> Value {
    json!({
        "plugin_id":"performance_demo","generation":"original-generation",
        "operation":"plugin.performance_demo.sample"
    })
}

#[test]
fn old_session_without_source_round_trips_without_fabricated_identity() {
    let original = old_session();
    let session: PerformanceSession = serde_json::from_value(original.clone()).unwrap();
    assert!(session.source.is_none());
    assert_eq!(serde_json::to_value(session).unwrap(), original);
}

#[test]
fn independent_source_keeps_its_generation_without_a_device() {
    let original = independent_source();
    let source: PerformanceSourceRef = serde_json::from_value(original.clone()).unwrap();
    assert!(source.device.is_none());
    assert_eq!(source.generation, "original-generation");
    assert_eq!(serde_json::to_value(source).unwrap(), original);
}

#[test]
fn device_source_round_trips_the_exact_provider_generation_and_local_id() {
    let mut source = independent_source();
    source["plugin_id"] = json!("android-device");
    source["operation"] = json!("plugin.android-device.performance.sample");
    source["device"] = json!({
        "provider_id":"android-device","generation":"original-generation",
        "local_id":"fixture-1"
    });
    let mut original = old_session();
    original["source"] = source;
    let session: PerformanceSession = serde_json::from_value(original.clone()).unwrap();
    let device = session.source.as_ref().unwrap().device.as_ref().unwrap();
    assert_eq!(device.generation, "original-generation");
    assert_eq!(device.local_id, "fixture-1");
    assert_eq!(serde_json::to_value(session).unwrap(), original);
}

#[test]
fn source_and_device_reject_unknown_fields() {
    let mut unknown = independent_source();
    unknown["executor_path"] = json!("request-controlled");
    assert!(serde_json::from_value::<PerformanceSourceRef>(unknown).is_err());
    let mut unknown_device = independent_source();
    unknown_device["device"] = json!({
        "provider_id":"android-device","generation":"original-generation",
        "local_id":"fixture-1","platform":"android"
    });
    assert!(serde_json::from_value::<PerformanceSourceRef>(unknown_device).is_err());
}

fn device_definition() -> (
    super::PerformanceSourceDefinition,
    crate::Operation,
    crate::devices::DeviceProviderDefinition,
) {
    use crate::devices::*;
    let operation = crate::Operation {
        id: "plugin.fixture.sample".into(),
        title: "采样".into(),
        execution: None,
        input_schema: json!({"type":"object","additionalProperties":false,
            "properties":{"device_id":{"type":"string"},"input":{"type":"object","additionalProperties":false,
                "properties":{"package":{"type":"string"}},"required":["package"]}},
            "required":["device_id","input"]}),
    };
    let source = super::PerformanceSourceDefinition {
        api_version: 2,
        operation: operation.id.clone(),
        fps: false,
        device_capability: Some(super::PerformanceDeviceCapability {
            id: "sample".into(),
            version: 1,
        }),
    };
    let provider = DeviceProviderDefinition {
        api_version: 3,
        platform: "fixture".into(),
        discover_operation: "plugin.fixture.discover".into(),
        capabilities: vec![DeviceCapability {
            id: "sample".into(),
            version: 1,
            operation: operation.id.clone(),
            scope: CapabilityScope::Device,
            access: CapabilityAccess::Read,
            execution_timeout_ms: Some(10000),
        }],
    };
    (source, operation, provider)
}

#[test]
fn source_requires_its_exact_read_capability_and_namespace() {
    use crate::devices::*;
    let (source, operation, provider) = device_definition();
    assert!(
        source
            .validate("fixture", std::slice::from_ref(&operation), Some(&provider))
            .is_ok()
    );
    assert!(
        source
            .validate("other", std::slice::from_ref(&operation), Some(&provider))
            .is_err()
    );
    assert!(
        source
            .validate("fixture", std::slice::from_ref(&operation), None)
            .is_err()
    );
    for change in 0..5 {
        let mut invalid = provider.clone();
        match change {
            0 => invalid.api_version = 2,
            1 => invalid.capabilities[0].version = 2,
            2 => invalid.capabilities[0].operation = "plugin.fixture.other".into(),
            3 => invalid.capabilities[0].scope = CapabilityScope::Provider,
            _ => invalid.capabilities[0].access = CapabilityAccess::Write,
        }
        assert!(
            source
                .validate("fixture", std::slice::from_ref(&operation), Some(&invalid))
                .is_err()
        );
    }
}

#[test]
fn sample_schema_cannot_open_extra_fields_or_hide_artifact_values_in_a_union() {
    let (source, operation, provider) = device_definition();
    for pointer in [
        "/additionalProperties",
        "/properties/input/additionalProperties",
    ] {
        let mut invalid = operation.clone();
        *invalid.input_schema.pointer_mut(pointer).unwrap() = json!(true);
        assert!(
            source
                .validate("fixture", &[invalid], Some(&provider))
                .is_err()
        );
    }
    for schema in [
        json!({"type":["string","object"]}),
        json!({"anyOf":[{"type":"string"},{"type":"object"}]}),
        json!({"type":"object"}),
        json!({"$ref":"#/$defs/arbitrary"}),
        json!({"type":"string","anyOf":[{"type":"string"},{"type":"object"}]}),
        json!({"type":"string","$ref":"#/$defs/arbitrary"}),
        json!({"type":"string","unknown":true}),
    ] {
        let mut invalid = operation.clone();
        invalid.input_schema["properties"]["input"]["properties"]["package"] = schema;
        assert!(
            source
                .validate("fixture", &[invalid], Some(&provider))
                .is_err()
        );
    }
    let mut missing = operation;
    missing.input_schema["properties"]["input"]["required"] = json!([]);
    assert!(
        source
            .validate("fixture", &[missing], Some(&provider))
            .is_err()
    );
}

#[test]
fn string_exclusions_only_accept_patterns_without_opening_schema_keywords() {
    let (source, operation, provider) = device_definition();
    let mut single_pattern = operation.clone();
    single_pattern.input_schema["properties"]["device_id"]["not"] = json!({"pattern":"^$"});
    assert!(
        source
            .validate("fixture", &[single_pattern], Some(&provider))
            .is_ok()
    );
    for exclusion in [
        json!(true),
        json!({}),
        json!({"pattern":1}),
        json!({"pattern":"^$","unknown":true}),
        json!({"$ref":"#/$defs/arbitrary"}),
        json!({"type":"object"}),
        json!({"anyOf":[]}),
        json!({"anyOf":true}),
        json!({"anyOf":[{"pattern":"^$"},{"$ref":"#/$defs/arbitrary"}]}),
        json!({"anyOf":[{"pattern":"^$","type":"string"}]}),
    ] {
        let mut invalid = operation.clone();
        invalid.input_schema["properties"]["device_id"]["not"] = exclusion;
        assert!(
            source
                .validate("fixture", &[invalid], Some(&provider))
                .is_err()
        );
    }
}

#[test]
fn real_android_manifests_register_their_device_sample_schema() {
    for (name, contents) in [
        (
            "manifest.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/android-device/manifest.json"
            )),
        ),
        (
            "manifest.example.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/android-device/manifest.example.json"
            )),
        ),
    ] {
        let manifest: Value = serde_json::from_str(contents).unwrap();
        let plugin_id = manifest["id"].as_str().unwrap();
        let declaration = &manifest["performance"];
        let sample_name = declaration["sample_operation"].as_str().unwrap();
        let sample = manifest["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"].as_str() == Some(sample_name))
            .unwrap();
        let (mut source, mut operation, mut provider) = device_definition();
        operation.id = format!("plugin.{plugin_id}.{sample_name}");
        operation.input_schema = sample["input_schema"].clone();
        source.api_version = u32::try_from(declaration["api_version"].as_u64().unwrap()).unwrap();
        source.operation = operation.id.clone();
        source.fps = declaration["fps"].as_bool().unwrap();
        let binding = source.device_capability.as_mut().unwrap();
        binding.id = declaration["device_capability"]["id"]
            .as_str()
            .unwrap()
            .into();
        binding.version = u32::try_from(
            declaration["device_capability"]["version"]
                .as_u64()
                .unwrap(),
        )
        .unwrap();
        let devices = &manifest["devices"];
        provider.api_version = u32::try_from(devices["api_version"].as_u64().unwrap()).unwrap();
        let capability = devices["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|capability| {
                capability["id"].as_str() == Some(binding.id.as_str())
                    && capability["version"].as_u64() == Some(u64::from(binding.version))
            })
            .unwrap();
        assert_eq!(capability["scope"], "device", "{name}");
        assert_eq!(capability["access"], "read", "{name}");
        let registered = &mut provider.capabilities[0];
        registered.id = binding.id.clone();
        registered.version = binding.version;
        registered.operation = format!(
            "plugin.{plugin_id}.{}",
            capability["operation"].as_str().unwrap()
        );
        assert!(
            source
                .validate(plugin_id, &[operation], Some(&provider))
                .is_ok(),
            "{name}"
        );
    }
}

#[test]
fn legacy_source_has_no_device_binding_and_does_not_require_device_schema() {
    let (mut source, mut operation, _) = device_definition();
    source.api_version = 1;
    assert!(
        source
            .validate("fixture", &[operation.clone()], None)
            .is_err()
    );
    source.device_capability = None;
    operation.input_schema = json!({"type":"object","properties":{"device_id":{"type":"string"},"package":{"type":"string"}}});
    assert!(
        source
            .validate("fixture", &[operation.clone()], None)
            .is_ok()
    );
    source.api_version = 3;
    assert!(source.validate("fixture", &[operation], None).is_err());
}
