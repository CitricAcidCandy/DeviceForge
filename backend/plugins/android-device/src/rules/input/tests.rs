//! 动作及设备端引用回归；不以宿主argv替代设备shell语义。
use super::*;
use serde_json::json;

#[test]
fn action_requires_known_fields_and_non_null_booleans() {
    for value in [
        json!({"kind":"tap","x":1,"y":2,"extra":true}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4}),
        json!({"kind":"keyevent","key_code":66,"long_press":null}),
        json!({"kind":"text","text":"x","enter":null}),
        json!({"kind":"text","text":"x","path":"local"}),
        json!({"kind":"unknown"}),
        json!({"kind":"tap","x":-1,"y":0}),
    ] {
        assert!(serde_json::from_value::<Action>(value).is_err());
    }
    let key: Action = serde_json::from_value(json!({"kind":"keyevent","key_code":66})).unwrap();
    assert_eq!(key.commands(), vec![vec!["keyevent", "66"]]);
}

#[test]
fn numeric_action_limits_are_inclusive_without_overflow_coercion() {
    for value in [
        json!({"kind":"tap","x":0,"y":32767}),
        json!({"kind":"swipe","x1":0,"y1":1,"x2":32767,"y2":2,"duration_ms":10000}),
        json!({"kind":"keyevent","key_code":65535,"long_press":true}),
    ] {
        assert!(
            serde_json::from_value::<Action>(value)
                .unwrap()
                .validate()
                .is_ok()
        );
    }
    for value in [
        json!({"kind":"tap","x":32768,"y":0}),
        json!({"kind":"swipe","x1":0,"y1":0,"x2":0,"y2":0,"duration_ms":0}),
        json!({"kind":"swipe","x1":0,"y1":0,"x2":0,"y2":0,"duration_ms":10001}),
        json!({"kind":"keyevent","key_code":0}),
        json!({"kind":"keyevent","key_code":65536}),
    ] {
        assert!(matches!(
            serde_json::from_value::<Action>(value).unwrap().validate(),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn text_quotes_device_shell_and_splits_literal_percent_s_before_enter() {
    let action = Action::Text {
        text: "a b'c%sZ".into(),
        enter: true,
    };
    assert_eq!(
        action.commands(),
        vec![
            vec!["text", "'a%sb'\\''c%'"],
            vec!["text", "'sZ'"],
            vec!["keyevent", "66"],
        ]
    );
    assert_eq!(text_arguments("%s%s"), vec!["'%'", "'s%'", "'s'"]);
    assert_eq!(text_arguments("a;$(b)\\c"), vec!["'a;$(b)\\c'"]);
}

#[test]
fn text_only_accepts_one_to_1024_printable_ascii_bytes() {
    assert!(
        Action::Text {
            text: "x".repeat(1024),
            enter: false
        }
        .validate()
        .is_ok()
    );
    for text in [
        String::new(),
        "x".repeat(1025),
        "中文".into(),
        "a\n".into(),
        "a\t".into(),
        "a\u{7f}".into(),
    ] {
        assert!(matches!(
            Action::Text { text, enter: false }.validate(),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn keyevent_longpress_and_coordinate_commands_are_fixed() {
    assert_eq!(
        Action::Keyevent {
            key_code: 66,
            long_press: true
        }
        .commands(),
        vec![vec!["keyevent", "--longpress", "66"]]
    );
    assert_eq!(
        Action::Tap { x: 0, y: 32767 }.commands(),
        vec![vec!["tap", "0", "32767"]]
    );
    assert_eq!(
        Action::Swipe {
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            duration_ms: 5
        }
        .commands(),
        vec![vec!["swipe", "1", "2", "3", "4", "5"]]
    );
}
