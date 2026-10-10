use super::*;
use apk_domain::{Error, Operation, devices::CapabilityScope};
use serde_json::{Value, json};

fn binding() -> Binding {
    Binding {
        operation: Operation {
            execution: None,
            id: "legacy.install".into(),
            title: "兼容安装".into(),
            input_schema: json!({"type":"object","properties":{"artifact_id":{"type":"string"}},"required":["artifact_id"]}),
        },
        target: Target::DeviceCapability {
            plugin_id: "sample".into(),
            capability: "app.install".into(),
            version: 1,
        },
        input: InputMapping::DeviceEnvelope,
        result: ResultMapping::Value { wrapped: true },
    }
}

fn config() -> Config {
    Config {
        format_version: 1,
        bindings: vec![binding()],
    }
}

fn artifact(filename: &str) -> Value {
    json!({"id":"host-artifact","filename":filename,"media_type":"image/png","size":3,"sha256":"a".repeat(64),"created_at":1})
}

fn wrapper(value: Value, artifacts: Vec<Value>) -> Value {
    json!({"result":value,"artifacts":artifacts})
}

fn field(source: FieldSource, optional: bool) -> ResultField {
    ResultField {
        name: "selected".into(),
        source,
        optional,
    }
}

fn object(source: FieldSource, optional: bool) -> ResultMapping {
    ResultMapping::Object {
        wrapped: true,
        fields: vec![field(source, optional)],
    }
}

fn invalid(result: apk_domain::Result<()>) {
    assert!(matches!(result, Err(Error::Invalid(_))));
}

fn dependency(result: apk_domain::Result<Value>) {
    assert!(matches!(result, Err(Error::Dependency(_))));
}

#[test]
fn empty_default_and_required_business_schema_are_valid() {
    let empty = Config::default();
    assert_eq!(empty.format_version, 1);
    assert!(empty.bindings.is_empty());
    empty.validate().unwrap();
    config().validate().unwrap();
    assert_eq!(binding().plugin_id(), "sample");
}

fn discovery_config() -> Config {
    Config {
        format_version: 2,
        bindings: vec![Binding {
            operation: Operation {
                execution: None,
                id: "android.devices".into(),
                title: "旧发现".into(),
                input_schema: json!({"type":"object","additionalProperties":false}),
            },
            target: Target::DeviceDiscovery {
                plugin_id: "sample".into(),
            },
            input: InputMapping::Identity,
            result: ResultMapping::DeviceDiscovery {
                platform: "android".into(),
            },
        }],
    }
}

#[test]
fn format_two_discovery_is_strict_and_does_not_reopen_format_one() {
    let valid = discovery_config();
    valid.validate().unwrap();
    let roundtrip: Config = serde_json::from_value(serde_json::to_value(&valid).unwrap()).unwrap();
    roundtrip.validate().unwrap();
    assert_eq!(roundtrip.bindings[0].plugin_id(), "sample");
    let mut old = valid.clone();
    old.format_version = 1;
    invalid(old.validate());
    for pointer in ["/bindings/0/target", "/bindings/0/result"] {
        let mut value = serde_json::to_value(&valid).unwrap();
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), json!(true));
        assert!(serde_json::from_value::<Config>(value).is_err());
    }
}

#[test]
fn discovery_profile_cannot_use_capability_or_wrong_platform_or_envelope() {
    let mut malformed = discovery_config();
    malformed.bindings[0].target = binding().target;
    invalid(malformed.validate());
    let mut malformed = discovery_config();
    malformed.bindings[0].result = ResultMapping::DeviceDiscovery {
        platform: "harmony".into(),
    };
    invalid(malformed.validate());
    let mut malformed = discovery_config();
    malformed.bindings[0].input = InputMapping::DeviceEnvelope;
    invalid(malformed.validate());
    let mut malformed = discovery_config();
    malformed.bindings[0].result = ResultMapping::Identity {};
    invalid(malformed.validate());
    let mut malformed = discovery_config();
    malformed.bindings[0].operation.input_schema = json!({"type":"object","required":["injected"]});
    invalid(malformed.validate());
}

#[test]
fn explicit_nonlegacy_discovery_alias_can_keep_identity_result() {
    let mut valid = discovery_config();
    valid.bindings[0].operation.id = "thirdparty.observe".into();
    valid.bindings[0].result = ResultMapping::Identity {};
    valid.validate().unwrap();
    let mut malformed = valid.clone();
    malformed.bindings[0].result = ResultMapping::Value { wrapped: false };
    invalid(malformed.validate());
    assert!(
        matches!(
            map_result(
                &ResultMapping::DeviceDiscovery {
                    platform: "android".into()
                },
                &json!({}),
                json!([])
            ),
            Err(Error::Dependency(_))
        ),
        "专用发现必须走完整观测验证，纯普通映射不能绕过"
    );
}

#[test]
fn configuration_rejects_unknown_fields_at_every_boundary() {
    let original = serde_json::to_value(config()).unwrap();
    for pointer in [
        "",
        "/bindings/0",
        "/bindings/0/operation",
        "/bindings/0/target",
        "/bindings/0/result",
    ] {
        let mut value = original.clone();
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), json!(true));
        assert!(
            serde_json::from_value::<Config>(value).is_err(),
            "{pointer}"
        );
    }
    let projection = ResultMapping::Object {
        wrapped: true,
        fields: vec![field(
            FieldSource::Input {
                pointer: "/artifact_id".into(),
            },
            false,
        )],
    };
    for pointer in ["/fields/0", "/fields/0/source"] {
        let mut value = serde_json::to_value(&projection).unwrap();
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), json!(true));
        assert!(serde_json::from_value::<ResultMapping>(value).is_err());
    }
    assert!(
        serde_json::from_value::<ResultMapping>(json!({"kind":"identity","wrapped":true})).is_err()
    );
}

#[test]
fn identity_result_keeps_wire_shape_and_rejects_every_extra_field() {
    let wire = json!({"kind":"identity"});
    let parsed: ResultMapping = serde_json::from_value(wire.clone()).unwrap();
    assert!(matches!(parsed, ResultMapping::Identity {}));
    assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
    assert_eq!(
        serde_json::to_value(ResultMapping::Identity {}).unwrap(),
        wire
    );
    for extra in [
        json!({"wrapped":true}),
        json!({"filename":"out.png"}),
        json!({"fields":[]}),
        json!({"unexpected":null}),
    ] {
        let mut invalid_wire = wire.clone();
        invalid_wire
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<ResultMapping>(invalid_wire.clone()).is_err());
        let mut declaration = serde_json::to_value(config()).unwrap();
        declaration["bindings"][0]["result"] = invalid_wire;
        assert!(serde_json::from_value::<Config>(declaration).is_err());
    }
}

#[test]
fn field_optional_defaults_to_false_and_tags_round_trip() {
    let value = json!({"name":"id","source":{"kind":"input","pointer":"/artifact_id"}});
    let parsed: ResultField = serde_json::from_value(value).unwrap();
    assert!(!parsed.optional);
    let serialized = serde_json::to_value(config()).unwrap();
    assert_eq!(
        serialized["bindings"][0]["target"]["kind"],
        "device_capability"
    );
    assert_eq!(serialized["bindings"][0]["input"], "device_envelope");
    let restored: Config = serde_json::from_value(serialized).unwrap();
    restored.validate().unwrap();
}

#[test]
fn version_count_and_duplicate_aliases_are_invalid_configuration() {
    let mut value = config();
    value.format_version = 3;
    invalid(value.validate());
    value = config();
    value.bindings.push(binding());
    invalid(value.validate());
    value = Config {
        format_version: 1,
        bindings: (0..256)
            .map(|index| {
                let mut entry = binding();
                entry.operation.id = format!("legacy.action_{index}");
                entry
            })
            .collect(),
    };
    value.validate().unwrap();
    let mut extra = binding();
    extra.operation.id = "legacy.extra".into();
    value.bindings.push(extra);
    invalid(value.validate());
}

#[test]
fn reserved_alias_and_nonlocal_schema_are_rejected() {
    for id in [
        "plugin.sample.alias",
        "deviceforge.alias",
        "-invalid",
        "bad/name",
    ] {
        let mut value = config();
        value.bindings[0].operation.id = id.into();
        invalid(value.validate());
    }
    for schema in [
        json!({"type":"string"}),
        json!({"type":"object","properties":{"x":{"$ref":"https://example.invalid/schema"}}}),
        json!({"type":"object","$id":"local"}),
    ] {
        let mut value = config();
        value.bindings[0].operation.input_schema = schema;
        invalid(value.validate());
    }
}

#[test]
fn legacy_discovery_aliases_reject_both_target_kinds() {
    let targets = [
        Target::Operation {
            plugin_id: "sample".into(),
            operation: "plugin.sample.echo".into(),
        },
        Target::DeviceCapability {
            plugin_id: "sample".into(),
            capability: "app.install".into(),
            version: 1,
        },
    ];
    for target in targets {
        for name in ["android.devices", "harmony.devices"] {
            let mut value = config();
            value.bindings[0].operation.id = name.into();
            value.bindings[0].target = target.clone();
            value.bindings[0].input = InputMapping::Identity;
            value.bindings[0].result = ResultMapping::Identity {};
            invalid(value.validate());
        }
        let mut ordinary = config();
        ordinary.bindings[0].operation.id = "legacy.echo".into();
        ordinary.bindings[0].target = target;
        ordinary.bindings[0].input = InputMapping::Identity;
        ordinary.bindings[0].result = ResultMapping::Identity {};
        ordinary.validate().unwrap();
    }
}

#[test]
fn host_result_requirement_depends_on_wrapping_or_any_artifact_source() {
    let cases = [
        (ResultMapping::Identity {}, false),
        (ResultMapping::Value { wrapped: false }, false),
        (ResultMapping::Value { wrapped: true }, true),
        (
            ResultMapping::Artifact {
                filename: "out.png".into(),
            },
            true,
        ),
        (
            ResultMapping::Object {
                wrapped: false,
                fields: vec![],
            },
            false,
        ),
        (
            ResultMapping::Object {
                wrapped: true,
                fields: vec![],
            },
            true,
        ),
        (
            ResultMapping::Object {
                wrapped: false,
                fields: vec![
                    ResultField {
                        name: "input".into(),
                        source: FieldSource::Input {
                            pointer: "/id".into(),
                        },
                        optional: false,
                    },
                    ResultField {
                        name: "value".into(),
                        source: FieldSource::Value {
                            pointer: "/id".into(),
                        },
                        optional: false,
                    },
                ],
            },
            false,
        ),
        (
            ResultMapping::Object {
                wrapped: false,
                fields: vec![
                    ResultField {
                        name: "value".into(),
                        source: FieldSource::Value {
                            pointer: "/id".into(),
                        },
                        optional: false,
                    },
                    ResultField {
                        name: "artifact".into(),
                        source: FieldSource::Artifact {
                            filename: "out.png".into(),
                        },
                        optional: true,
                    },
                ],
            },
            true,
        ),
    ];
    for (mapping, expected) in cases {
        assert_eq!(mapping.requires_host_result(), expected, "{mapping:?}");
    }
}

#[test]
fn target_namespace_version_and_mapping_must_agree() {
    let mut value = config();
    value.bindings[0].target = Target::Operation {
        plugin_id: "sample".into(),
        operation: "plugin.other.run".into(),
    };
    value.bindings[0].input = InputMapping::Identity;
    invalid(value.validate());
    value.bindings[0].target = Target::Operation {
        plugin_id: "sample".into(),
        operation: "plugin.sample.run".into(),
    };
    value.validate().unwrap();
    value.bindings[0].input = InputMapping::DeviceEnvelope;
    invalid(value.validate());
    value = config();
    if let Target::DeviceCapability { version, .. } = &mut value.bindings[0].target {
        *version = 0;
    }
    invalid(value.validate());
}

#[test]
fn field_and_pointer_limits_reject_duplicate_or_unsafe_rules() {
    let mut value = config();
    value.bindings[0].result = ResultMapping::Object {
        wrapped: false,
        fields: (0..32)
            .map(|index| ResultField {
                name: format!("field_{index}"),
                source: FieldSource::Value { pointer: "".into() },
                optional: false,
            })
            .collect(),
    };
    value.validate().unwrap();
    if let ResultMapping::Object { fields, .. } = &mut value.bindings[0].result {
        fields.push(field(FieldSource::Value { pointer: "".into() }, false));
    }
    invalid(value.validate());
    for pointer in [
        "relative",
        "/bad~",
        "/bad~2",
        &format!("/{}", "x".repeat(128)),
    ] {
        let mut value = config();
        value.bindings[0].result = object(
            FieldSource::Input {
                pointer: pointer.into(),
            },
            false,
        );
        invalid(value.validate());
    }
    value.bindings[0].result = ResultMapping::Object {
        wrapped: false,
        fields: vec![field(FieldSource::Value { pointer: "".into() }, false); 2],
    };
    invalid(value.validate());
}

#[test]
fn filenames_are_exact_bounded_names_not_paths() {
    for filename in [
        "",
        "../out.png",
        "a/b.png",
        "a\\b.png",
        "C:out.png",
        ".hidden",
        "out.png ",
        &"x".repeat(181),
    ] {
        let mut value = config();
        value.bindings[0].result = ResultMapping::Artifact {
            filename: filename.into(),
        };
        invalid(value.validate());
    }
    let mut value = config();
    value.bindings[0].result = ResultMapping::Artifact {
        filename: "截图.png".into(),
    };
    value.validate().unwrap();
}

#[test]
fn device_envelope_preserves_business_fields_without_mutating_input() {
    let input = json!({"device_id":"serial-1","artifact_id":"source","action":{"kind":"tap"}});
    let mapped = map_input(
        &InputMapping::DeviceEnvelope,
        &input,
        Some(&CapabilityScope::Device),
    )
    .unwrap();
    assert_eq!(
        mapped,
        json!({"device_id":"serial-1","input":{"artifact_id":"source","action":{"kind":"tap"}}})
    );
    assert_eq!(input["artifact_id"], "source");
    assert!(input.get("input").is_none());
    assert_eq!(
        map_input(&InputMapping::Identity, &input, None).unwrap(),
        input
    );
}

#[test]
fn provider_scope_accepts_only_missing_or_null_device_id() {
    for input in [
        json!({"address":"host:5555"}),
        json!({"device_id":null,"address":"host:5555"}),
    ] {
        assert_eq!(
            map_input(
                &InputMapping::DeviceEnvelope,
                &input,
                Some(&CapabilityScope::Provider)
            )
            .unwrap(),
            json!({"device_id":null,"input":{"address":"host:5555"}})
        );
    }
    for input in [
        json!({"device_id":"serial"}),
        json!({"device_id":0}),
        json!(null),
    ] {
        assert!(matches!(
            map_input(
                &InputMapping::DeviceEnvelope,
                &input,
                Some(&CapabilityScope::Provider)
            ),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn device_scope_rejects_missing_invalid_or_unscoped_ids() {
    for input in [
        json!({}),
        json!({"device_id":null}),
        json!({"device_id":1}),
        json!({"device_id":""}),
        json!({"device_id":"-option"}),
    ] {
        assert!(matches!(
            map_input(
                &InputMapping::DeviceEnvelope,
                &input,
                Some(&CapabilityScope::Device)
            ),
            Err(Error::Invalid(_))
        ));
    }
    assert!(
        map_input(
            &InputMapping::DeviceEnvelope,
            &json!({"device_id":"serial"}),
            None
        )
        .is_err()
    );
}

#[test]
fn identity_and_unwrapped_value_never_guess_a_result_wrapper() {
    let raw = json!({"result":{"business":true},"artifacts":"business-field","other":1});
    assert_eq!(
        map_result(&ResultMapping::Identity {}, &json!({}), raw.clone()).unwrap(),
        raw
    );
    assert_eq!(
        map_result(
            &ResultMapping::Value { wrapped: false },
            &json!({}),
            raw.clone()
        )
        .unwrap(),
        raw
    );
}

#[test]
fn wrapped_value_requires_exact_and_well_formed_host_wrapper() {
    let mapping = ResultMapping::Value { wrapped: true };
    assert_eq!(
        map_result(
            &mapping,
            &json!({}),
            wrapper(json!({"output":"ok"}), vec![])
        )
        .unwrap(),
        json!({"output":"ok"})
    );
    for malformed in [
        json!({"result":1}),
        json!({"artifacts":[]}),
        json!({"result":1,"artifacts":[],"extra":true}),
        json!({"result":1,"artifacts":null}),
        json!({"result":1,"artifacts":[{"filename":"out.png"}]}),
    ] {
        dependency(map_result(&mapping, &json!({}), malformed));
    }
}

#[test]
fn artifact_uses_only_unique_host_metadata_not_plugin_result() {
    let mapping = ResultMapping::Artifact {
        filename: "screenshot.png".into(),
    };
    let host = artifact("screenshot.png");
    let result = wrapper(
        json!({"id":"forged","filename":"screenshot.png"}),
        vec![artifact("other.png"), host.clone()],
    );
    assert_eq!(map_result(&mapping, &json!({}), result).unwrap(), host);
    for artifacts in [
        vec![],
        vec![artifact("Screenshot.png")],
        vec![host.clone(), host],
    ] {
        dependency(map_result(
            &mapping,
            &json!({}),
            wrapper(json!({}), artifacts),
        ));
    }
}

#[test]
fn object_projection_combines_input_value_and_host_artifact() {
    let mapping = ResultMapping::Object {
        wrapped: true,
        fields: vec![
            ResultField {
                name: "source_artifact_id".into(),
                source: FieldSource::Input {
                    pointer: "/artifact_id".into(),
                },
                optional: false,
            },
            ResultField {
                name: "output".into(),
                source: FieldSource::Value {
                    pointer: "/output".into(),
                },
                optional: false,
            },
            ResultField {
                name: "artifact".into(),
                source: FieldSource::Artifact {
                    filename: "out.png".into(),
                },
                optional: false,
            },
        ],
    };
    let host = artifact("out.png");
    let mapped = map_result(
        &mapping,
        &json!({"artifact_id":"source"}),
        wrapper(json!({"output":"ok"}), vec![host.clone()]),
    )
    .unwrap();
    assert_eq!(
        mapped,
        json!({"source_artifact_id":"source","output":"ok","artifact":host})
    );
}

#[test]
fn pointer_supports_root_unicode_escapes_and_canonical_array_indices() {
    let input = json!({"键/名":{"~值":["first","second"]}});
    let mapping = object(
        FieldSource::Input {
            pointer: "/键~1名/~0值/1".into(),
        },
        false,
    );
    assert_eq!(
        map_result(&mapping, &input, wrapper(json!(null), vec![])).unwrap(),
        json!({"selected":"second"})
    );
    let mapping = ResultMapping::Object {
        wrapped: false,
        fields: vec![field(FieldSource::Value { pointer: "".into() }, false)],
    };
    assert_eq!(
        map_result(&mapping, &json!({}), json!([1, 2])).unwrap(),
        json!({"selected":[1,2]})
    );
}

#[test]
fn optional_skips_missing_sources_but_preserves_explicit_null() {
    for source in [
        FieldSource::Input {
            pointer: "/absent".into(),
        },
        FieldSource::Value {
            pointer: "/absent".into(),
        },
        FieldSource::Artifact {
            filename: "missing.png".into(),
        },
    ] {
        assert_eq!(
            map_result(
                &object(source.clone(), true),
                &json!({}),
                wrapper(json!({}), vec![])
            )
            .unwrap(),
            json!({})
        );
        dependency(map_result(
            &object(source, false),
            &json!({}),
            wrapper(json!({}), vec![]),
        ));
    }
    let mapping = object(
        FieldSource::Value {
            pointer: "/nullable".into(),
        },
        true,
    );
    assert_eq!(
        map_result(
            &mapping,
            &json!({}),
            wrapper(json!({"nullable":null}), vec![])
        )
        .unwrap(),
        json!({"selected":null})
    );
}

#[test]
fn optional_never_hides_bad_pointer_traversal_or_duplicate_artifacts() {
    for pointer in [
        "/items/01",
        "/items/-",
        "/items/-1",
        "/scalar/child",
        "/bad~2",
    ] {
        let mapping = object(
            FieldSource::Value {
                pointer: pointer.into(),
            },
            true,
        );
        dependency(map_result(
            &mapping,
            &json!({}),
            wrapper(json!({"items":[1],"scalar":7}), vec![]),
        ));
    }
    let mapping = object(
        FieldSource::Artifact {
            filename: "out.png".into(),
        },
        true,
    );
    dependency(map_result(
        &mapping,
        &json!({}),
        wrapper(json!({}), vec![artifact("out.png"), artifact("out.png")]),
    ));
    dependency(map_result(
        &mapping,
        &json!({}),
        json!({"result":{},"artifacts":[{"filename":"other.png"}]}),
    ));
}

#[test]
fn unwrapped_artifact_projection_still_requires_host_wrapper() {
    let mapping = ResultMapping::Object {
        wrapped: false,
        fields: vec![field(
            FieldSource::Artifact {
                filename: "out.png".into(),
            },
            false,
        )],
    };
    dependency(map_result(
        &mapping,
        &json!({}),
        json!({"filename":"out.png"}),
    ));
    assert_eq!(
        map_result(
            &mapping,
            &json!({}),
            wrapper(json!({}), vec![artifact("out.png")])
        )
        .unwrap(),
        json!({"selected":artifact("out.png")})
    );
}

#[test]
fn out_of_range_array_is_missing_but_numeric_object_keys_are_literal() {
    let mapping = object(
        FieldSource::Value {
            pointer: "/items/999999999999999999999999999999999999".into(),
        },
        true,
    );
    assert_eq!(
        map_result(&mapping, &json!({}), wrapper(json!({"items":[1]}), vec![])).unwrap(),
        json!({})
    );
    let mapping = object(
        FieldSource::Value {
            pointer: "/items/01".into(),
        },
        false,
    );
    assert_eq!(
        map_result(
            &mapping,
            &json!({}),
            wrapper(json!({"items":{"01":"literal"}}), vec![])
        )
        .unwrap(),
        json!({"selected":"literal"})
    );
}
