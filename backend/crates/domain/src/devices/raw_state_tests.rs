//! 原始状态的纯版本、字节边界与序列化回归，不参与发现调度。
use super::*;
use crate::Error;
use serde_json::json;

fn definition(api_version: u32) -> DeviceProviderDefinition {
    DeviceProviderDefinition {
        api_version,
        platform: "第三方模拟平台".into(),
        discover_operation: "plugin.sample.discover".into(),
        capabilities: vec![],
    }
}

fn device(raw_state: Option<&str>) -> ProvidedDevice {
    ProvidedDevice {
        reference: DeviceRef {
            provider_id: "sample".into(),
            generation: "generation".into(),
            local_id: "local".into(),
        },
        state: DeviceState::Unknown,
        raw_state: raw_state.map(str::to_owned),
        model: None,
        capabilities: vec![],
    }
}

#[test]
fn legacy_versions_allow_absence_but_reject_every_non_null_raw_state() {
    for api in [1, 2] {
        assert!(rules::devices(&definition(api), &[device(None)]).is_ok());
        for raw in ["", " ", "recovery", "Vendor.Mode"] {
            assert!(matches!(
                rules::devices(&definition(api), &[device(Some(raw))]),
                Err(Error::Invalid(_))
            ));
        }
    }
}

#[test]
fn api_three_preserves_unknown_text_and_counts_utf8_bytes() {
    let definition = definition(3);
    assert!(rules::devices(&definition, &[device(None)]).is_ok());
    for raw in [
        " Vendor.Recovery 模式 ".to_owned(),
        "sideload".to_owned(),
        "bootloader".to_owned(),
        "x".repeat(100),
        format!("{}a", "界".repeat(33)),
    ] {
        let device = device(Some(&raw));
        assert!(rules::devices(&definition, std::slice::from_ref(&device)).is_ok());
        assert_eq!(device.raw_state.as_deref(), Some(raw.as_str()));
        assert_eq!(device.state, DeviceState::Unknown);
        assert_eq!(
            serde_json::to_value(device).unwrap()["raw_state"],
            json!(raw)
        );
    }
}

#[test]
fn api_three_rejects_whitespace_control_characters_and_byte_overflow() {
    for raw in [
        "".to_owned(),
        " \u{3000}".to_owned(),
        "recovery\n".to_owned(),
        "raw\0state".to_owned(),
        "raw\u{0085}state".to_owned(),
        "x".repeat(101),
        format!("{}ab", "界".repeat(33)),
    ] {
        assert!(matches!(
            rules::devices(&definition(3), &[device(Some(&raw))]),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn invalid_device_rejects_the_complete_observation() {
    let mut invalid = device(Some("invalid\tstate"));
    invalid.reference.local_id = "other".into();
    let devices = [device(Some("Vendor.Mode")), invalid];
    assert!(matches!(
        rules::devices(&definition(3), &devices),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn missing_or_null_raw_state_serializes_as_omitted() {
    let value = serde_json::to_value(device(None)).unwrap();
    assert!(value.get("raw_state").is_none());
    let original: ProvidedDevice = serde_json::from_value(value.clone()).unwrap();
    assert!(original.raw_state.is_none());
    let mut explicit = value.clone();
    explicit["raw_state"] = serde_json::Value::Null;
    let null: ProvidedDevice = serde_json::from_value(explicit).unwrap();
    assert!(null.raw_state.is_none());
    assert_eq!(serde_json::to_value(null).unwrap(), value);
}
