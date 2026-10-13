use super::*;
use deviceforge_android_package_core::apks::DeviceSpec;

fn spec() -> DeviceSpec {
    DeviceSpec {
        supported_abis: vec!["arm64-v8a".into()],
        supported_locales: vec!["zh-CN".into()],
        screen_density: 480,
        sdk_version: 35,
        ..DeviceSpec::default()
    }
}

#[test]
fn default_bundletool_json_and_argv_remain_the_original_four_field_request() {
    let payload = serde_json::to_value(spec().bundletool()).unwrap();
    assert_eq!(
        payload,
        json!({"supportedAbis":["arm64-v8a"],"supportedLocales":["zh-CN"],"screenDensity":480,"sdkVersion":35})
    );
    assert_eq!(
        arguments(
            Path::new("input.apks"),
            Path::new("out"),
            Path::new("spec.json"),
            &Selection::default()
        ),
        [
            "extract-apks",
            "--apks=input.apks",
            "--output-dir=out",
            "--device-spec=spec.json"
        ]
    );
}

#[test]
fn advanced_specs_map_exact_official_camel_case_names_and_string_device_tier() {
    let mut value = spec();
    value.device_features = vec!["android.hardware.camera".into()];
    value.gl_extensions = vec!["GL_KHR_texture_compression_astc_ldr".into()];
    value.codename = Some("REL".into());
    value.device_tier = Some("3".into());
    let payload = serde_json::to_value(value.bundletool()).unwrap();
    assert_eq!(
        payload["deviceFeatures"],
        json!(["android.hardware.camera"])
    );
    assert_eq!(
        payload["glExtensions"],
        json!(["GL_KHR_texture_compression_astc_ldr"])
    );
    assert_eq!(payload["codename"], "REL");
    assert_eq!(payload["deviceTier"], "3");
    assert!(payload.get("device_features").is_none());
}

#[test]
fn modules_and_instant_are_fixed_argv_items_instead_of_user_flags() {
    let selection = Selection {
        modules: Some(vec!["base".into(), "feature_1".into()]),
        instant: true,
    };
    let args = arguments(
        Path::new("input.apks"),
        Path::new("out"),
        Path::new("spec.json"),
        &selection,
    );
    assert_eq!(&args[4..], ["--modules=base,feature_1", "--instant"]);
    let selection = Selection {
        modules: Some(vec!["ALL".into()]),
        instant: false,
    };
    assert_eq!(
        &arguments(
            Path::new("input.apks"),
            Path::new("out"),
            Path::new("spec.json"),
            &selection
        )[4..],
        ["--modules=ALL"]
    );
}
