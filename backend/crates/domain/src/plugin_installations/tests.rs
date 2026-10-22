use super::*;

fn release() -> ReleaseManifest {
    serde_json::from_value(serde_json::json!({
        "format_version":1,"host_api_version":2,"id":"sample","version":"1.0.0",
        "name":"测试插件","description":"测试完整发布校验",
        "components":[{"id":"sample","kind":"browser","version":"1.0.0","variants":[{
            "platform":"any","path":"browser.zip","sha256":"a".repeat(64),"size":10,"format":"zip"
        }]}],
        "tools":[{"id":"helper","version":"1.0","variants":[{
            "platform":"any","path":"helper.bin","sha256":"b".repeat(64),"size":1,
            "format":"file","entries":{"executable":"payload"}
        }],"bindings":[{"component_id":"sample","config_pointer":"/helper/path","entry":"executable"}]}]
    })).unwrap()
}

#[test]
fn required_defaults_true_and_binding_validates() {
    let release = release();
    assert!(release.tools[0].required);
    release.validate().unwrap();
}

#[test]
fn rejects_missing_binding_entry_and_invalid_pointer() {
    let mut release = release();
    release.tools[0].bindings[0].entry = "missing".into();
    assert!(release.validate().is_err());
    release.tools[0].bindings[0].entry = "executable".into();
    release.tools[0].bindings[0].config_pointer = "/bad~2key".into();
    assert!(release.validate().is_err());
}

#[test]
fn rejects_unsafe_paths_and_noncanonical_digest() {
    for path in [
        "../escape",
        "a/../b",
        "C:/tool",
        "a\\tool",
        "//host/a",
        "CON.exe",
        "a%2fb",
        "a/hidden.",
    ] {
        assert!(validate_release_path(path).is_err(), "{path}");
    }
    assert!(validate_release_digest(&"A".repeat(64)).is_err());
    validate_release_path("bin/helper.exe").unwrap();
}

#[test]
fn optional_tool_can_lack_variants_but_required_tool_cannot() {
    let mut release = release();
    release.tools[0].variants.clear();
    assert!(release.validate().is_err());
    release.tools[0].required = false;
    release.validate().unwrap();
}

#[test]
fn rejects_component_format_and_duplicate_binding_targets() {
    let mut release = release();
    release.components[0].variants[0].format = ResourceFormat::File;
    assert!(release.validate().is_err());
    release.components[0].variants[0].format = ResourceFormat::Zip;
    let duplicate = release.tools[0].bindings[0].clone();
    release.tools[0].bindings.push(duplicate);
    assert!(release.validate().is_err());
}
