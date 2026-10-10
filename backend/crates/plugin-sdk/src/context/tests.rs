use super::*;
use serde_json::{Value, json};

#[test]
fn frames_preserve_exact_wire_and_zero_is_expired_not_default() {
    let ready = json!({"protocol_version":4,"request_id":"call","command":"ready"});
    let parsed: ReadyFrame = serde_json::from_value(ready.clone()).unwrap();
    assert_eq!(parsed, ReadyFrame::new("call"));
    assert_eq!(serde_json::to_value(parsed).unwrap(), ready);
    for remaining in [0, 1, MAX_REMAINING_TIMEOUT_NS] {
        let start = StartFrame::new("call", remaining);
        start.validate().unwrap();
        let wire = json!({"protocol_version":4,"request_id":"call","command":"start","remaining_timeout_ns":remaining});
        assert_eq!(serde_json::to_value(&start).unwrap(), wire);
        assert_eq!(serde_json::from_value::<StartFrame>(wire).unwrap(), start);
    }
}

#[test]
fn frames_reject_missing_and_unknown_fields() {
    for mut wire in [
        json!({"protocol_version":4,"request_id":"call","command":"ready"}),
        json!({"protocol_version":4,"request_id":"call","command":"start","remaining_timeout_ns":1}),
    ] {
        let start = wire["command"] == "start";
        let keys: Vec<_> = wire.as_object().unwrap().keys().cloned().collect();
        for key in keys {
            let mut missing = wire.clone();
            missing.as_object_mut().unwrap().remove(&key);
            assert_rejected(missing, start);
        }
        wire["extra"] = json!(true);
        assert_rejected(wire, start);
    }
}

#[test]
fn identity_and_commands_are_strict() {
    for start in [false, true] {
        let valid = if start {
            serde_json::to_value(StartFrame::new("call", 1)).unwrap()
        } else {
            serde_json::to_value(ReadyFrame::new("call")).unwrap()
        };
        for (field, value) in [
            ("protocol_version", json!(3)),
            ("protocol_version", json!(4.0)),
            ("protocol_version", json!("4")),
            ("request_id", json!("")),
            ("request_id", json!("a".repeat(129))),
            ("command", json!("cancel")),
            ("command", json!({"ready":null})),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert_rejected(invalid, start);
        }
    }
    ReadyFrame::new("a".repeat(128)).validate().unwrap();
    assert!(ReadyFrame::new("界".repeat(43)).validate().is_err());
}

#[test]
fn remaining_requires_bounded_unsigned_integer() {
    for value in [
        json!(-1),
        json!(1.0),
        json!("1"),
        Value::Null,
        json!(true),
        json!(MAX_REMAINING_TIMEOUT_NS + 1),
    ] {
        let mut invalid = serde_json::to_value(StartFrame::new("call", 1)).unwrap();
        invalid["remaining_timeout_ns"] = value;
        assert_rejected(invalid, true);
    }
}

#[test]
fn literal_validation_rejects_invalid_identity_and_budget() {
    let mut ready = ReadyFrame::new("call");
    ready.protocol_version = 3;
    assert!(ready.validate().is_err());
    let mut start = StartFrame::new("call", MAX_REMAINING_TIMEOUT_NS + 1);
    assert!(start.validate().is_err());
    start.remaining_timeout_ns = 0;
    start.request_id.clear();
    assert!(start.validate().is_err());
}

fn assert_rejected(wire: Value, start: bool) {
    if start {
        assert!(serde_json::from_value::<StartFrame>(wire).is_err());
    } else {
        assert!(serde_json::from_value::<ReadyFrame>(wire).is_err());
    }
}
