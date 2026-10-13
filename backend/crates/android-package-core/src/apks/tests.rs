use super::*;
use crate::{Control, Error};
use std::time::{Duration, Instant};

fn control() -> Control<'static> {
    Control::new(None, &|| false)
}

fn spec() -> DeviceSpec {
    DeviceSpec {
        supported_abis: vec!["arm64-v8a".into(), "armeabi-v7a".into()],
        supported_locales: vec!["zh-CN".into()],
        screen_density: 480,
        sdk_version: 35,
        ..DeviceSpec::default()
    }
}

#[test]
fn standard_four_fields_keep_preference_order_and_optional_defaults() {
    let value = spec();
    value.validate(&control()).unwrap();
    let payload = value.bundletool();
    assert_eq!(payload.supported_abis, ["arm64-v8a", "armeabi-v7a"]);
    assert!(payload.device_features.is_empty());
    assert!(payload.gl_extensions.is_empty());
    assert_eq!(payload.codename, None);
    assert_eq!(payload.device_tier, None);
    Selection::default().validate(&control()).unwrap();
}

#[test]
fn advanced_feature_gl_codename_and_string_tier_are_validated_without_tool_calls() {
    let mut value = spec();
    value.device_features = vec!["android.hardware.camera".into()];
    value.gl_extensions = vec!["GL_KHR_texture_compression_astc_ldr".into()];
    value.codename = Some("REL".into());
    value.device_tier = Some("3".into());
    value.validate(&control()).unwrap();
    let payload = value.bundletool();
    assert_eq!(payload.device_tier, Some("3"));
    assert_eq!(payload.device_features, ["android.hardware.camera"]);
}

#[test]
fn feature_and_extension_lists_reject_duplicates_counts_and_invalid_tokens() {
    for entries in [
        vec!["a".into(); 257],
        vec!["a".into(), "a".into()],
        vec![String::new()],
        vec!["a".repeat(161)],
        vec!["GL extension".into()],
        vec!["a\0b".into()],
    ] {
        let mut value = spec();
        value.device_features = entries.clone();
        assert!(matches!(
            value.validate(&control()),
            Err(Error::InvalidArgument(_))
        ));
        value.device_features.clear();
        value.gl_extensions = entries;
        assert!(matches!(
            value.validate(&control()),
            Err(Error::InvalidArgument(_))
        ));
    }
}

#[test]
fn combined_device_spec_text_has_a_bound_below_the_private_json_file_limit() {
    let mut value = spec();
    value.device_features = (0..256)
        .map(|index| format!("f{index:03}{}", "a".repeat(156)))
        .collect();
    value.gl_extensions = (0..256)
        .map(|index| format!("g{index:03}{}", "a".repeat(156)))
        .collect();
    assert!(matches!(
        value.validate(&control()),
        Err(Error::InvalidArgument("设备规格字符串合计超过48KiB"))
    ));
}

#[test]
fn module_names_and_all_sentinel_are_explicit_and_preserve_request_order() {
    for modules in [vec!["base".into(), "feature_1".into()], vec!["ALL".into()]] {
        Selection {
            modules: Some(modules),
            instant: true,
        }
        .validate(&control())
        .unwrap();
    }
    for modules in [
        Vec::new(),
        vec!["ALL".into(), "base".into()],
        vec!["base".into(), "base".into()],
        vec!["--flag".into()],
        vec!["1module".into()],
        vec!["a,b".into()],
        vec!["../base".into()],
        vec!["a".repeat(81)],
        vec!["base".into(); 129],
    ] {
        assert!(matches!(
            Selection {
                modules: Some(modules),
                instant: false
            }
            .validate(&control()),
            Err(Error::InvalidArgument(_))
        ));
    }
}

#[test]
fn advanced_public_validation_keeps_pre_cancel_and_expired_control_categories() {
    let cancelled = Control::new(None, &|| true);
    assert!(matches!(spec().validate(&cancelled), Err(Error::Cancelled)));
    assert!(matches!(
        Selection::default().validate(&cancelled),
        Err(Error::Cancelled)
    ));
    let expired = Control::new(Some(Instant::now() - Duration::from_secs(1)), &|| true);
    assert!(matches!(spec().validate(&expired), Err(Error::Timeout)));
    assert!(matches!(
        Selection::default().validate(&expired),
        Err(Error::Timeout)
    ));
}
