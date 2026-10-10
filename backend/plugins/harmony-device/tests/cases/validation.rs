use crate::support::{Fixture, SERIAL, device};
use serde_json::json;

#[test]
fn unknown_operation_and_unknown_envelope_fields_are_rejected_without_hdc() {
    let fixture = Fixture::new("strict-operation");
    fixture.reject(
        fixture.request("harmony.devices", json!({})),
        "输入无效：鸿蒙设备插件只接受本批四个短贡献名",
    );

    let fixture = Fixture::new("strict-envelope");
    let mut request = fixture.request("packages", device(json!({})));
    request["input"]["extra"] = json!(true);
    fixture.reject(request, "输入无效：设备动作封套或业务字段不符合严格格式");
}

#[test]
fn discover_requires_empty_object_and_device_actions_require_strict_envelopes() {
    let fixture = Fixture::new("strict-discover");
    let request = fixture.request("discover", json!({"extra":true}));
    fixture.reject(request, "输入无效：设备动作封套或业务字段不符合严格格式");

    for (input, expected) in [
        (
            json!({"input":{}}),
            "输入无效：设备动作封套必须显式提供device_id和input",
        ),
        (
            json!({"device_id":SERIAL,"input":{},"extra":true}),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            json!({"device_id":null,"input":{}}),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
    ] {
        let fixture = Fixture::new("strict-device-envelope");
        let request = fixture.request("packages", input);
        fixture.reject(request, expected);
    }
}

#[test]
fn install_requires_uuid_and_uninstall_requires_dot_ascii_package_before_hdc() {
    let fixture = Fixture::new("strict-install-id");
    let request = crate::support::artifacts::installation(&fixture, b"hap");
    let mut bad = request.clone();
    bad["input"]["input"]["artifact_id"] = json!("bad-id");
    fixture.reject(bad, "输入无效：产物ID须为标准连字符UUID");

    for package in ["app", "com..app", "com.1bad", "设备.应用"] {
        let fixture = Fixture::new("strict-package");
        fixture.reject(
            fixture.request("app.uninstall", device(json!({"package":package}))),
            "输入无效：应用包名须为最多200字节的点分ASCII标识",
        );
    }
}
