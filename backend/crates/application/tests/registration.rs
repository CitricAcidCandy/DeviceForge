use apk_application::registration::validate_operations;
use apk_domain::Operation;
use serde_json::json;

#[test]
fn offline_validation_shares_namespace_schema_and_duplicate_rules() {
    let operation = Operation {
        id: "plugin.example.echo".into(),
        title: "回显".into(),
        input_schema: json!({"type":"object","additionalProperties":false}),
    };
    validate_operations(std::slice::from_ref(&operation)).unwrap();
    assert!(validate_operations(&[operation.clone(), operation.clone()]).is_err());
    for (id, schema) in [
        ("deviceforge.reserved", json!({"type":"object"})),
        ("plugin.example.echo", json!({"type":"string"})),
        (
            "plugin.example.echo",
            json!({"type":"object","properties":{"x":{"$ref":"https://example.com/schema"}}}),
        ),
        (
            "plugin.example.echo",
            json!({"type":"object","properties":{"x":{"type":"invalid"}}}),
        ),
    ] {
        assert!(
            validate_operations(&[Operation {
                id: id.into(),
                title: "无效".into(),
                input_schema: schema
            }])
            .is_err()
        );
    }
}
