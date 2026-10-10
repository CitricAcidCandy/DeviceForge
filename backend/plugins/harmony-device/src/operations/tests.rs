use super::*;

#[test]
fn four_short_contributions_require_strict_inputs() {
    assert!(matches!(
        parse("discover", &json!({})).unwrap(),
        Input::Discover
    ));
    assert!(matches!(
        parse("packages", &json!({"device_id":"HDC001","input":{}})).unwrap(),
        Input::Packages { .. }
    ));
    assert!(matches!(parse("app.install", &json!({"device_id":"HDC001","input":{"artifact_id":"d0da1b1b-919c-40a8-9c71-fbb56614e488"}})).unwrap(), Input::Install { .. }));
    assert!(matches!(
        parse(
            "app.uninstall",
            &json!({"device_id":"HDC001","input":{"package":"com.example.app"}})
        )
        .unwrap(),
        Input::Uninstall { .. }
    ));
}

#[test]
fn missing_extra_and_wrong_fields_fail_before_configuration() {
    for value in [
        json!({"device_id":"HDC001"}),
        json!({"device_id":"HDC001","input":null}),
        json!({"device_id":"HDC001","input":{},"extra":true}),
        json!({"device_id":"HDC001","input":{"extra":true}}),
        json!({"device_id":null,"input":{}}),
        json!({"device_id":"-flag","input":{}}),
        json!([]),
    ] {
        assert!(parse("packages", &value).is_err());
    }
    assert!(parse("discover", &json!({"device_id":"HDC001","input":{}})).is_err());
    for operation in [
        "plugin.harmony-device.packages",
        "harmony.packages",
        "app.start",
    ] {
        assert!(parse(operation, &json!({})).is_err());
    }
}

#[test]
fn artifact_and_package_business_values_do_not_allow_shell_arguments() {
    for artifact_id in [
        "not-uuid",
        "../input.hap",
        "d0da1b1b-919c-40a8-9c71-fbb56614e488 --flag",
    ] {
        assert!(
            parse(
                "app.install",
                &json!({"device_id":"HDC001","input":{"artifact_id":artifact_id}})
            )
            .is_err()
        );
    }
    for package in ["app", "com.example;id", "com.1bad", "com..app"] {
        assert!(
            parse(
                "app.uninstall",
                &json!({"device_id":"HDC001","input":{"package":package}})
            )
            .is_err()
        );
    }
}
