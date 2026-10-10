use super::SessionDefinition;
use crate::{OperationExecution, OperationExecutionSource};
use serde_json::json;

fn definition() -> SessionDefinition {
    SessionDefinition {
        id: "plugin.example.shell".into(),
        title: "交互会话".into(),
        input_schema: json!({"type":"object"}),
        execution: None,
    }
}

#[test]
fn declaration_keeps_binary_protocol_separate_from_open_schema() {
    let definition = definition();
    definition.validate("example").unwrap();
    assert_eq!(definition.protocol_version(), 5);
    assert_eq!(definition.chunk_limit(), 8192);
    let value = serde_json::to_value(definition).unwrap();
    assert!(value.get("execution").is_none());
    assert_eq!(value["input_schema"]["type"], "object");
}

#[test]
fn namespace_and_full_identifier_limit_are_both_enforced() {
    let mut definition = definition();
    assert!(definition.validate("another").is_err());
    definition.id = "plugin.example.Uppercase".into();
    assert!(definition.validate("example").is_err());
    let plugin_id = "a".repeat(99);
    definition.id = format!("plugin.{plugin_id}.{}", "b".repeat(30));
    assert!(definition.validate(&plugin_id).is_err());
    definition.id = "plugin.example.".into();
    assert!(definition.validate("example").is_err());
}

#[test]
fn open_schema_reuses_object_and_document_local_reference_policy() {
    let mut definition = definition();
    definition.input_schema = json!({
        "type":"object", "$defs":{"value":{"type":"string"}},
        "properties":{"value":{"$ref":"#/$defs/value"}}
    });
    definition.validate("example").unwrap();
    for reference in ["file:///private.json", "https://example.invalid/schema"] {
        definition.input_schema["properties"]["value"]["$ref"] = json!(reference);
        assert!(definition.validate("example").is_err());
    }
    definition.input_schema = json!({"type":"array"});
    assert!(definition.validate("example").is_err());
}

#[test]
fn direct_definition_budget_is_validated_before_registration() {
    let mut definition = definition();
    definition.execution = Some(OperationExecution {
        api_version: 1,
        total_timeout_ms: 1,
        source: OperationExecutionSource::Declared,
    });
    definition.validate("example").unwrap();
    definition.execution.as_mut().unwrap().total_timeout_ms = 3_600_001;
    assert!(definition.validate("example").is_err());
    definition.execution.as_mut().unwrap().total_timeout_ms = 60_000;
    definition.execution.as_mut().unwrap().api_version = 2;
    assert!(definition.validate("example").is_err());
}

