//! 使用真实公开模式验证标签补齐、分支选择与保守拒绝，不复制插件配置模型。
use super::*;
use serde_json::json;

fn definition(id: &str) -> Value {
    let manifest = match id {
        "device" => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/android-device/manifest.json"
        )),
        "packages" => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/android-packages/manifest.json"
        )),
        _ => unreachable!(),
    };
    serde_json::from_str::<Value>(manifest).unwrap()["configuration"].clone()
}

#[test]
fn real_android_schemas_complete_tagged_entries_from_empty_legacy_tools() {
    let path = json!(std::env::current_exe().unwrap());
    for (id, tools) in [
        ("device", vec![("bundletool", "jar", "java_jar")]),
        (
            "packages",
            vec![
                ("apkanalyzer", "executable", "executable"),
                ("apksigner", "jar", "java_jar"),
                ("bundletool", "jar", "java_jar"),
                ("apktool", "jar", "java_jar"),
            ],
        ),
    ] {
        let definition = definition(id);
        let original = definition["defaults"].clone();
        assert_eq!(original["tools"], json!({}));
        let mut values = original.clone();
        for (tool, entry, kind) in tools {
            values = bind(
                &definition["schema"],
                &values,
                &format!("/tools/{tool}/{entry}"),
                path.clone(),
            )
            .unwrap();
            assert_eq!(values["tools"][tool]["kind"], kind);
            assert_eq!(values["tools"][tool][entry], path);
        }
        assert!(jsonschema::is_valid(&definition["schema"], &values));
        assert_eq!(original["tools"], json!({}));
    }
}

#[test]
fn existing_kind_is_never_replaced_with_a_different_branch() {
    let definition = definition("packages");
    let mut values = definition["defaults"].clone();
    values["tools"]["apksigner"] = json!({"kind":"executable","executable":"custom-apksigner"});
    assert!(jsonschema::is_valid(&definition["schema"], &values));
    let original = values.clone();
    assert!(matches!(
        bind(&definition["schema"], &values, "/tools/apksigner/jar", json!("managed.jar")),
        Err(Error::Invalid(message)) if message.contains("不匹配")
    ));
    assert_eq!(values, original);
    values["tools"]["bundletool"] = json!({"kind":"executable"});
    assert!(
        bind(
            &definition["schema"],
            &values,
            "/tools/bundletool/jar",
            json!("managed.jar")
        )
        .is_err()
    );
}

#[test]
fn ambiguous_and_unmatched_alternatives_fail_without_mutating_input() {
    for keyword in ["anyOf", "oneOf"] {
        let mut schema = json!({"type":"object","properties":{"tool":{}}});
        schema["properties"]["tool"][keyword] = json!([
            {"type":"object","properties":{"kind":{"const":"first"},"path":{"type":"string"}},"required":["kind","path"]},
            {"type":"object","properties":{"kind":{"const":"second"},"path":{"type":"string"}},"required":["kind","path"]}
        ]);
        let original = json!({});
        assert!(matches!(
            bind(&schema, &original, "/tool/path", json!("managed")),
            Err(Error::Invalid(message)) if message.contains("歧义")
        ));
        assert_eq!(original, json!({}));
        let explicit = json!({"tool":{"kind":"second"}});
        assert_eq!(
            bind(&schema, &explicit, "/tool/path", json!("managed")).unwrap(),
            json!({"tool":{"kind":"second","path":"managed"}})
        );
        assert!(matches!(
            bind(&schema, &json!({"tool":{"kind":"other"}}), "/tool/path", json!("managed")),
            Err(Error::Invalid(message)) if message.contains("不匹配")
        ));
        assert!(bind(&schema, &original, "/tool/unknown", json!("managed")).is_err());
    }
}

#[test]
fn loose_and_dictionary_schemas_preserve_plain_path_binding_compatibility() {
    for schema in [
        json!({"type":"object"}),
        json!({"type":"object","properties":{"tools":{"type":"object","additionalProperties":{"type":"string"}}}}),
        json!({"type":"object","properties":{"tools":{"type":"object","patternProperties":{"^runner$":{"type":"string"}},"additionalProperties":false}}}),
    ] {
        let bound = bind(&schema, &json!({}), "/tools/runner", json!("managed")).unwrap();
        assert_eq!(bound, json!({"tools":{"runner":"managed"}}));
        assert!(jsonschema::is_valid(&schema, &bound));
    }
    let closed = json!({"type":"object","additionalProperties":false});
    assert!(bind(&closed, &json!({}), "/tools/runner", json!("managed")).is_err());
}

#[test]
fn unrelated_one_of_branches_with_identical_results_are_not_ambiguous() {
    let schema = json!({"type":"object","properties":{"path":{"type":"string"},"mode":{"type":"string"}},
    "oneOf":[
        {"properties":{"mode":{"const":"first"}},"required":["mode"]},
        {"properties":{"mode":{"const":"second"}},"required":["mode"]}
    ]});
    let values = json!({"mode":"second"});
    let bound = bind(&schema, &values, "/path", json!("managed")).unwrap();
    assert_eq!(bound, json!({"mode":"second","path":"managed"}));
    assert!(jsonschema::is_valid(&schema, &bound));
    let schema = json!({"type":"object","properties":{"path":{"type":"string"},"mode":{"type":"integer"}},
        "oneOf":[{"properties":{"mode":{"minimum":10}}},{"properties":{"mode":{"maximum":9}}}]});
    let bound = bind(&schema, &json!({"mode":2}), "/path", json!("managed")).unwrap();
    assert_eq!(bound, json!({"mode":2,"path":"managed"}));
    assert!(jsonschema::is_valid(&schema, &bound));
}

#[test]
fn local_refs_all_of_and_existing_array_items_keep_const_and_pointer_rules() {
    let schema = json!({
        "type":"object","properties":{"a/b":{"type":"array","items":{"$ref":"#/$defs/entry"}}},
        "$defs":{"entry":{"allOf":[
            {"type":"object","properties":{"kind":{"$ref":"#/$defs/kind"},"~path":{"type":"string"}}},
            {"required":["kind","~path"]}
        ]},"kind":{"const":"executable"}}
    });
    let values = json!({"a/b":[{}]});
    let bound = bind(&schema, &values, "/a~1b/0/~0path", json!("managed")).unwrap();
    assert_eq!(
        bound,
        json!({"a/b":[{"kind":"executable","~path":"managed"}]})
    );
    assert!(jsonschema::is_valid(&schema, &bound));
    assert!(bind(&schema, &values, "/a~1b/01/~0path", json!("managed")).is_err());
    assert!(bind(&schema, &values, "/a~1b/1/~0path", json!("managed")).is_err());
}
