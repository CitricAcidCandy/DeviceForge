use super::Input;
use serde_json::{Value, json};

const ID: &str = "12345678-1234-4234-8234-123456789abc";

fn accepts(suffix: &str, value: Value) -> bool {
    Input::parse(suffix, &value).is_ok()
}

fn spec() -> Value {
    json!({"supported_abis":["arm64-v8a"],"supported_locales":["zh-CN"],
        "screen_density":420,"sdk_version":34})
}

#[test]
fn all_seven_operations_accept_their_declared_input() {
    for suffix in ["manifest", "signature", "decode"] {
        assert!(accepts(suffix, json!({"artifact_id":ID})));
    }
    assert!(accepts(
        "manifest",
        json!({"artifact_id":ID,"module":"feature_1"})
    ));
    assert!(accepts(
        "extract_apk",
        json!({"artifact_id":ID,"entry":"splits/base.apk"})
    ));
    for mode in ["default", "universal"] {
        assert!(accepts("build_apks", json!({"artifact_id":ID,"mode":mode})));
    }
    assert!(accepts(
        "scan_sdks",
        json!({"artifact_id":ID,"rules":[
        {"name":"中文规则","package_path":"com.example","class_name":"Entry$Inner"},
        {"name":"缺省类名","package_path":"org.example"}]})
    ));
    assert!(accepts(
        "extract_splits",
        json!({"artifact_id":ID,"device_spec":spec()})
    ));
}

#[test]
fn input_rejects_unknown_operation_and_root_fields() {
    assert!(!accepts("unknown", json!({"artifact_id":ID})));
    for name in [
        "manifest",
        "signature",
        "extract_apk",
        "build_apks",
        "decode",
        "scan_sdks",
        "extract_splits",
    ] {
        assert!(!accepts(
            &format!("plugin.android-packages.{name}"),
            json!({"artifact_id":ID})
        ));
    }
    for value in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"artifact_id":123}),
        json!({"artifact_id":ID,"path":"private.apk"}),
        json!({"artifact_id":ID,"total_timeout_ms":100}),
    ] {
        assert!(!accepts("signature", value));
    }
}

#[test]
fn module_rejects_explicit_null_and_invalid_names() {
    for module in [
        Value::Null,
        json!(1),
        json!(""),
        json!("1base"),
        json!("a-b"),
        json!("中文"),
        json!("a".repeat(81)),
    ] {
        assert!(!accepts(
            "manifest",
            json!({"artifact_id":ID,"module":module})
        ));
    }
}

#[test]
fn artifact_id_requires_canonical_uuid_shape() {
    for id in [
        "",
        "not-a-uuid",
        "12345678123442348234123456789abc",
        "{12345678-1234-4234-8234-123456789abc}",
        "12345678-1234-4234-8234-123456789abg",
    ] {
        assert!(!accepts("signature", json!({"artifact_id":id})));
    }
}

#[test]
fn build_mode_is_a_closed_string_enum() {
    for mode in [
        json!("other"),
        json!("Default"),
        json!({"default":null}),
        Value::Null,
        json!(2),
    ] {
        assert!(!accepts(
            "build_apks",
            json!({"artifact_id":ID,"mode":mode})
        ));
    }
}

#[test]
fn exact_entry_rejects_traversal_and_has_utf8_byte_bound() {
    for entry in [
        "../base.apk",
        "/base.apk",
        "a//base.apk",
        "a/./base.apk",
        "a\\base.apk",
        "C:base.apk",
        "base.apks",
        "a\n.apk",
        "a/../base.apk",
    ] {
        assert!(!accepts(
            "extract_apk",
            json!({"artifact_id":ID,"entry":entry})
        ));
    }
    assert!(accepts(
        "extract_apk",
        json!({"artifact_id":ID,"entry":format!("{}.apk", "a".repeat(496))})
    ));
    assert!(!accepts(
        "extract_apk",
        json!({"artifact_id":ID,"entry":format!("{}.apk", "中".repeat(166))})
    ));
}
