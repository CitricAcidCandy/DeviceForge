//! 部署配置只解析严格模型，空配置不要求安装平台工具。
use super::Config;
use serde_json::json;

#[test]
fn empty_deployment_and_supported_entries_are_valid_without_tool_reads() {
    assert!(Config::default().validate().is_ok());
    let root = std::env::temp_dir();
    let value = json!({"format_version":1,"tools":{"java":"java","apkanalyzer":{"kind":"executable","executable":"apkanalyzer"},"bundletool":{"kind":"java_jar","jar":root.join("missing.jar")}},"signing":null});
    let config: Config = serde_json::from_value(value).unwrap();
    assert!(config.validate().is_ok());
}

#[test]
fn unknown_fields_conflicting_entry_types_and_partial_signing_are_rejected() {
    for value in [
        json!({"format_version":1,"unexpected":true}),
        json!({"format_version":1,"tools":{"bundletool":{"kind":"java_jar","jar":"x","executable":"y"}}}),
        json!({"format_version":1,"signing":{"alias":"release"}}),
        json!({"format_version":1,"tools":{"extra":null}}),
        json!({"format_version":1.5}),
    ] {
        assert!(serde_json::from_value::<Config>(value).is_err());
    }
}

#[test]
fn invalid_paths_commands_and_tool_policies_do_not_fall_back() {
    for value in [
        json!({"format_version":2}),
        json!({"format_version":1,"tools":{"java":"java -jar tool.jar"}}),
        json!({"format_version":1,"tools":{"bundletool":{"kind":"executable","executable":"tool"}}}),
        json!({"format_version":1,"tools":{"apkanalyzer":{"kind":"java_jar","jar":std::env::temp_dir().join("x.jar")}}}),
        json!({"format_version":1,"scratch_root":"../outside"}),
        json!({"format_version":1,"tools":{"java":"java\u{0000}"}}),
    ] {
        assert!(
            serde_json::from_value::<Config>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
