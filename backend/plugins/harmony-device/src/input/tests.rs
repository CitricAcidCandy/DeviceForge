use super::*;
use serde_json::json;

mod receipts;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

pub(super) async fn with_control<Output, Work, WorkFuture>(work: Work) -> Output
where
    Output: Send + 'static,
    Work: FnOnce(Control) -> WorkFuture + Send + 'static,
    WorkFuture: std::future::Future<Output = Output> + Send + 'static,
{
    use deviceforge_plugin_runtime::{Execution, serve_io_with_context};
    use tokio::io::AsyncWriteExt;
    let (mut host, plugin) = tokio::io::duplex(4096);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let runtime = tokio::spawn(serve_io_with_context(
        plugin,
        tokio::io::sink(),
        move |_, context| async move {
            assert!(
                sender
                    .send(work(Control::new(context, "unused-hdc".into())).await)
                    .is_ok()
            );
            Execution::complete(Ok(deviceforge_plugin_runtime::Output::from(Value::Null)))
        },
    ));
    host.write_all(b"{\"protocol_version\":4,\"request_id\":\"input-library\",\"operation\":\"input\",\"input\":{}}\n{\"protocol_version\":4,\"request_id\":\"input-library\",\"command\":\"start\",\"remaining_timeout_ns\":30000000000}\n").await.unwrap();
    let result = receiver.await.unwrap();
    runtime.await.unwrap().unwrap();
    drop(host);
    result
}

#[test]
fn input_uses_native_coordinate_velocity_and_text_location_semantics() {
    for action in [
        json!({"kind":"tap","x":1,"y":32767}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":40000}),
        json!({"kind":"keyevent","key_code":2054}),
        json!({"kind":"text","x":1,"y":2,"text":"设备工坊 %s '$HOME'","enter":true}),
    ] {
        assert!(parse("HDC001".into(), &json!({"action":action})).is_ok());
    }
    let input = parse(
        "HDC001".into(),
        &json!({"action":{"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4}}),
    )
    .unwrap();
    assert_eq!(
        scripts::action(&input.action).unwrap(),
        "uitest uiInput swipe 1 2 3 4 600"
    );
    let input = parse(
        "HDC001".into(),
        &json!({"action":{"kind":"text","x":1,"y":2,"text":"hello"}}),
    )
    .unwrap();
    assert!(!input.action.enter());
}

#[test]
fn input_rejects_wrong_layers_unknown_fields_and_android_only_fields() {
    for value in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"action":null}),
        json!({"action":[]} ),
        json!({"action":{"kind":"tap","x":1,"y":2},"tool":"uitest"}),
        json!({"action":{"kind":"tap","x":1,"y":2,"text":"ignored"}}),
        json!({"action":{"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"duration_ms":100}}),
        json!({"action":{"kind":"keyevent","key_code":1,"long_press":false}}),
        json!({"action":{"kind":"text","text":"hello"}}),
        json!({"action":{"kind":"text","x":1,"y":2,"text":"hello","enter":null}}),
        json!({"action":{"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":null}}),
        json!({"action":{"kind":"unknown","x":1,"y":2}}),
    ] {
        assert!(parse("HDC001".into(), &value).is_err(), "{value}");
    }
}

#[test]
fn input_rejects_non_integer_types_coordinate_overflow_and_zero() {
    for value in [
        Value::Null,
        json!(-1),
        json!(0),
        json!(32768),
        json!(4294967296u64),
        json!(18446744073709551615u64),
        json!(1.5),
        json!("1"),
        json!(true),
        json!([]),
        json!({}),
    ] {
        let input = json!({"action":{"kind":"tap","x":value,"y":1}});
        assert!(parse("HDC001".into(), &input).is_err(), "{input}");
    }
    for action in [
        json!({"kind":"swipe","x1":1,"y1":2,"x2":1,"y2":2}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":199}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":40001}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":200.5}),
    ] {
        assert!(parse("HDC001".into(), &json!({"action":action})).is_err());
    }
}

#[test]
fn native_key_table_keeps_documented_gaps_and_excludes_android_enter() {
    for value in [
        1, 2, 18, 2054, 2122, 2632, 2634, 2834, 2836, 2839, 2841, 3109,
    ] {
        assert!(rules::key_code(value));
    }
    for value in [
        0,
        3,
        20,
        21,
        66,
        1999,
        2123,
        2633,
        2835,
        2840,
        3110,
        u32::MAX,
    ] {
        assert!(!rules::key_code(value));
        assert!(
            parse(
                "HDC001".into(),
                &json!({"action":{"kind":"keyevent","key_code":value}})
            )
            .is_err()
        );
    }
}

#[test]
fn text_budget_counts_utf8_bytes_and_rejects_device_shell_controls() {
    for text in [" ".into(), "a".repeat(1024), "界".repeat(341)] {
        assert!(
            parse(
                "HDC001".into(),
                &json!({"action":{"kind":"text","x":1,"y":2,"text":text}})
            )
            .is_ok()
        );
    }
    for text in [
        "".into(),
        "a".repeat(1025),
        "界".repeat(342),
        "a\0b".into(),
        "a\nb".into(),
        "a\tb".into(),
        "a\u{85}b".into(),
    ] {
        assert!(
            parse(
                "HDC001".into(),
                &json!({"action":{"kind":"text","x":1,"y":2,"text":text}})
            )
            .is_err()
        );
    }
}

#[test]
fn argv_keeps_device_separate_and_quotes_all_text_metacharacters_literally() {
    let action = Action::Text {
        x: 12,
        y: 34,
        text: "设备 a'b %s $HOME `id` ; & | \\".into(),
        enter: false,
    };
    let command = scripts::action(&action).unwrap();
    assert_eq!(
        command,
        "uitest uiInput inputText 12 34 '设备 a'\\''b %s $HOME `id` ; & | \\'"
    );
    let args = scripts::args("host:5555", TOKEN, "action", &command).unwrap();
    assert_eq!(&args[..3], ["-t", "host:5555", "shell"]);
    assert_eq!(args.len(), 4);
    assert!(args[3].ends_with("printf '\\nDF_INPUT_DONE:0123456789abcdef0123456789abcdef:action:%s\\n' \"$input_status\"\n"));
    for serial in ["", "-flag", "serial;id", "serial\n", "设备"] {
        assert!(parse(serial.into(), &json!({"action":{"kind":"tap","x":1,"y":2}})).is_err());
        assert!(scripts::args(serial, TOKEN, "action", "uitest help").is_err());
    }
    for token in [
        "",
        "ABCDEF0123456789ABCDEF0123456789AB",
        "../owner",
        "0123456789abcdef0123456789abcde;",
    ] {
        assert!(scripts::args("HDC001", token, "action", "uitest help").is_err());
    }
    assert!(scripts::args("HDC001", TOKEN, "action:other", "uitest help").is_err());
    assert_ne!(scripts::token().unwrap(), scripts::token().unwrap());
}
