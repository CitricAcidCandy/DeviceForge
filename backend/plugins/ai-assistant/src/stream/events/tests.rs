use super::*;

const ID: &str = "12345678-1234-1234-1234-123456789abc";

fn prefix() -> String {
    format!(
        "{{\"type\":\"thread.started\",\"thread_id\":\"{ID}\"}}\n{{\"type\":\"turn.started\"}}\n"
    )
}

fn answer(text: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":text}})
    )
}

#[test]
fn complete_lines_across_utf8_fragments_redact_and_whitelist_real_text() {
    let environment = BTreeMap::from([("API_TOKEN".into(), "secret-sentinel".into())]);
    let mut events = Events::new(None, &environment).unwrap();
    let raw = format!(
        "{}{}{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":3}}}}",
        prefix(),
        answer("中文secret-sentinel回答")
    );
    let mut output = Vec::new();
    for byte in raw.as_bytes() {
        output.extend(events.feed(&[*byte]).unwrap());
    }
    output.extend(events.finish().unwrap());
    assert_eq!(events.thread(), Some(ID));
    assert_eq!(events.text(), "中文[已隐藏]回答");
    assert_eq!(output.len(), 4);
    assert!(output.iter().all(|event| event["format_version"] == 1));
    assert!(
        !serde_json::to_string(&output)
            .unwrap()
            .contains("secret-sentinel")
    );
    assert!(output[3].get("usage").is_none());
}

#[test]
fn command_output_failure_details_and_unknown_fields_never_escape() {
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    let output = events.feed(b"{\"type\":\"item.completed\",\"raw\":\"hidden\",\"item\":{\"id\":\"tool_1\",\"type\":\"command_execution\",\"status\":\"failed\",\"command\":\"hidden-command\",\"aggregated_output\":\"hidden-output\",\"error\":\"hidden-error\"}}\n").unwrap();
    assert_eq!(
        output,
        [
            json!({"format_version":1,"type":"item.completed","item":{"id":"item_1","type":"command_execution","status":"failed"}})
        ]
    );
    assert!(
        events
            .feed(b"{\"type\":\"error\",\"message\":\"hidden-secret\"}\n")
            .unwrap_err()
            .contains("已隐藏")
    );
}

#[test]
fn cancelled_partial_failed_duplicate_and_late_turns_cannot_finish_successfully() {
    for raw in [
        prefix(),
        format!("{}{}", prefix(), answer("partial")),
        format!("{}{{\"type\":\"turn.failed\"}}\n", prefix()),
        format!("{}{}{}", prefix(), answer("one"), answer("duplicate")),
        format!(
            "{}{}{{\"type\":\"turn.completed\"}}\n{{\"type\":\"turn.started\"}}\n",
            prefix(),
            answer("one")
        ),
    ] {
        let mut events = Events::new(None, &BTreeMap::new()).unwrap();
        assert!(
            events
                .feed(raw.as_bytes())
                .and_then(|_| events.finish())
                .is_err()
        );
    }
}

#[test]
fn malformed_utf8_json_lines_and_line_limit_fail_with_finite_errors() {
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    assert!(events.feed(&[0xff, b'\n']).is_err());
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    assert!(events.feed(b"not-json\n").is_err());
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    assert!(events.feed(&vec![b' '; LINE_LIMIT + 1]).is_err());
}

#[test]
fn resume_threads_are_normalized_and_conflicting_provider_identity_is_rejected() {
    let mut events = Events::new(Some(ID.to_ascii_uppercase()), &BTreeMap::new()).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    assert_eq!(events.thread(), Some(ID));
    let mut events = Events::new(
        Some("87654321-1234-1234-1234-123456789abc".into()),
        &BTreeMap::new(),
    )
    .unwrap();
    assert!(events.feed(prefix().as_bytes()).is_err());
    let mut events = Events::new(Some(ID.into()), &BTreeMap::new()).unwrap();
    events.feed(b"{\"type\":\"turn.started\"}\n").unwrap();
    events.feed(answer("resumed").as_bytes()).unwrap();
    events.feed(b"{\"type\":\"turn.completed\"}\n").unwrap();
    events.finish().unwrap();
}

#[test]
fn pending_items_type_changes_empty_answer_and_event_limit_are_rejected() {
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    events
        .feed(b"{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"reasoning\"}}\n")
        .unwrap();
    assert!(events.feed(b"{\"type\":\"turn.completed\"}\n").is_err());
    assert!(events.feed(answer("changed").as_bytes()).is_err());
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    events.feed(answer(" ").as_bytes()).unwrap();
    events.feed(b"{\"type\":\"turn.completed\"}\n").unwrap();
    assert!(events.finish().is_err());
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    for _ in 0..10000 {
        events.feed(b"{\"type\":\"future.event\"}\n").unwrap();
    }
    assert!(events.feed(b"{\"type\":\"future.event\"}\n").is_err());
}

#[test]
fn sensitive_configuration_work_and_expanded_answer_remain_bounded() {
    let environment: BTreeMap<_, _> = (0..129)
        .map(|index| (format!("KEY_{index}"), "value".into()))
        .collect();
    assert!(Events::new(None, &environment).is_err());
    let mut events = Events::new(None, &BTreeMap::new()).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    for index in 0..8 {
        let line = format!(
            "{}\n",
            json!({"type":"item.completed","item":{"id":format!("answer_{index}"),"type":"agent_message","text":"a".repeat(60000)}})
        );
        events.feed(line.as_bytes()).unwrap();
    }
    let line = format!(
        "{}\n",
        json!({"type":"item.completed","item":{"id":"overflow","type":"agent_message","text":"a".repeat(60000)}})
    );
    assert!(events.feed(line.as_bytes()).is_err());
}

#[test]
fn updated_messages_are_full_snapshots_and_provider_item_ids_never_escape() {
    let environment = BTreeMap::from([("API_TOKEN".into(), "secret-sentinel".into())]);
    let mut events = Events::new(None, &environment).unwrap();
    events.feed(prefix().as_bytes()).unwrap();
    let mut output = Vec::new();
    for (kind, text) in [
        ("item.started", "前"),
        ("item.updated", "前后"),
        ("item.completed", "前后"),
    ] {
        let line = format!(
            "{}\n",
            json!({"type":kind,"item":{"id":"secret-sentinel","type":"agent_message","text":text}})
        );
        output.extend(events.feed(line.as_bytes()).unwrap());
    }
    events.feed(b"{\"type\":\"turn.completed\"}\n").unwrap();
    events.finish().unwrap();
    assert!(output.iter().all(|event| event["item"]["id"] == "item_1"));
    assert_eq!(output[1]["item"]["text"], "前后");
    assert_eq!(events.text(), "前后");
    assert!(
        !serde_json::to_string(&output)
            .unwrap()
            .contains("secret-sentinel")
    );
}
