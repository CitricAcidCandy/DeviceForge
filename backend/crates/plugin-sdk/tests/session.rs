use apk_plugin_sdk::{
    ArtifactOutput, Manifest,
    context::MAX_REMAINING_TIMEOUT_NS,
    cooperative::{CancelReason, CleanupOutcome},
    session::{
        SESSION_CHUNK_LIMIT, SESSION_PROTOCOL_VERSION, SessionControl, SessionEvent, SessionOpen,
        SessionOutcome, SessionReady, SessionStart, SessionStream,
    },
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

// 直接构造的纯校验与相同线格式的解析必须给出一致准入结果。
fn assert_literal_matches_wire<T>(value: &T, validate: fn(&T) -> Result<(), &'static str>)
where
    T: Serialize + DeserializeOwned,
{
    let wire = serde_json::to_value(value).unwrap();
    assert_eq!(
        serde_json::from_value::<T>(wire.clone()).is_ok(),
        validate(value).is_ok(),
        "字面量与反序列化准入不一致：{wire}",
    );
}

fn assert_required_and_closed<T: DeserializeOwned>(wire: Value, required: &[&str]) {
    assert!(serde_json::from_value::<T>(wire.clone()).is_ok());
    let mut extra = wire.clone();
    extra
        .as_object_mut()
        .unwrap()
        .insert("未声明字段".into(), Value::Null);
    assert!(serde_json::from_value::<T>(extra).is_err());
    for field in required {
        let mut missing = wire.clone();
        missing.as_object_mut().unwrap().remove(*field);
        assert!(
            serde_json::from_value::<T>(missing).is_err(),
            "未拒绝缺失字段：{field}"
        );
    }
}

fn success(cleanup: CleanupOutcome) -> SessionOutcome {
    SessionOutcome {
        result: Some(Value::Null),
        error: None,
        outputs: Vec::new(),
        cleanup,
    }
}

#[test]
fn handshake_preserves_complete_wire_and_optional_artifacts() {
    let wire = json!({
        "protocol_version": 5, "session_id": "会话", "command": "open",
        "operation": "terminal", "input": null,
        "artifacts": {"inputs": [], "output_directory": null},
    });
    let open: SessionOpen = serde_json::from_value(wire.clone()).unwrap();
    assert!(open.validate().is_ok());
    assert_eq!(open.input, Value::Null);
    assert!(open.artifacts.is_some());
    assert_eq!(serde_json::to_value(open).unwrap(), wire);
    let open = SessionOpen::new("s", "terminal", json!({"args": ["shell"]}));
    assert_literal_matches_wire(&open, SessionOpen::validate);
    assert_eq!(
        serde_json::to_value(open).unwrap(),
        json!({
            "protocol_version": 5, "session_id": "s", "command": "open",
            "operation": "terminal", "input": {"args": ["shell"]},
        })
    );
    let ready = SessionReady::new("s");
    assert_literal_matches_wire(&ready, SessionReady::validate);
    assert_eq!(
        serde_json::to_value(ready).unwrap(),
        json!({
            "protocol_version": 5, "session_id": "s", "command": "ready",
        })
    );
}

#[test]
fn start_keeps_zero_and_maximum_original_budget() {
    for budget in [0, MAX_REMAINING_TIMEOUT_NS] {
        let start = SessionStart::new("s", budget);
        assert_literal_matches_wire(&start, SessionStart::validate);
        let wire = json!({"protocol_version": 5, "session_id": "s", "command": "start", "remaining_timeout_ns": budget});
        assert_eq!(serde_json::to_value(&start).unwrap(), wire);
        assert_eq!(serde_json::from_value::<SessionStart>(wire).unwrap(), start);
    }
    let invalid = SessionStart::new("s", MAX_REMAINING_TIMEOUT_NS + 1);
    assert!(invalid.validate().is_err());
    assert_literal_matches_wire(&invalid, SessionStart::validate);
    for budget in [json!(-1), json!(1.5), json!("0"), Value::Null, json!(true)] {
        let wire = json!({"protocol_version": 5, "session_id": "s", "command": "start", "remaining_timeout_ns": budget});
        assert!(serde_json::from_value::<SessionStart>(wire).is_err());
    }
}

#[test]
fn session_identity_counts_utf8_bytes_across_frame_kinds() {
    let boundary = format!("{}ab", "会".repeat(42));
    assert_eq!(boundary.len(), 128);
    for id in [
        "s".to_owned(),
        boundary.clone(),
        String::new(),
        format!("{boundary}c"),
    ] {
        let valid = !id.is_empty() && id.len() <= 128;
        let open = SessionOpen::new(id.clone(), "terminal", Value::Null);
        let ready = SessionReady::new(id.clone());
        let start = SessionStart::new(id.clone(), 0);
        let eof = SessionControl::Eof {
            protocol_version: 5,
            session_id: id.clone(),
        };
        let output = SessionEvent::output(id, 1, SessionStream::Stdout, Vec::new());
        assert_eq!(open.validate().is_ok(), valid);
        assert_eq!(ready.validate().is_ok(), valid);
        assert_eq!(start.validate().is_ok(), valid);
        assert_eq!(eof.validate().is_ok(), valid);
        assert_eq!(output.validate().is_ok(), valid);
        assert_literal_matches_wire(&open, SessionOpen::validate);
        assert_literal_matches_wire(&ready, SessionReady::validate);
        assert_literal_matches_wire(&start, SessionStart::validate);
        assert_literal_matches_wire(&eof, SessionControl::validate);
        assert_literal_matches_wire(&output, SessionEvent::validate);
    }
}

#[test]
fn operation_names_and_protocol_versions_have_literal_parity() {
    let operation = format!("{}ab", "命".repeat(42));
    for name in [operation.clone(), String::new(), format!("{operation}c")] {
        let open = SessionOpen::new("s", name.clone(), Value::Null);
        assert_eq!(
            open.validate().is_ok(),
            !name.is_empty() && name.len() <= 128
        );
        assert_literal_matches_wire(&open, SessionOpen::validate);
    }
    for version in [0, 1, 4, 6, u32::MAX] {
        let mut open = SessionOpen::new("s", "terminal", Value::Null);
        open.protocol_version = version;
        let mut ready = SessionReady::new("s");
        ready.protocol_version = version;
        let mut start = SessionStart::new("s", 0);
        start.protocol_version = version;
        let input = SessionControl::Input {
            protocol_version: version,
            session_id: "s".into(),
            bytes: Vec::new(),
        };
        let event = SessionEvent::Output {
            protocol_version: version,
            session_id: "s".into(),
            sequence: 1,
            stream: SessionStream::Stdout,
            bytes: Vec::new(),
        };
        assert!(open.validate().is_err());
        assert!(ready.validate().is_err());
        assert!(start.validate().is_err());
        assert!(input.validate().is_err());
        assert!(event.validate().is_err());
        assert_literal_matches_wire(&open, SessionOpen::validate);
        assert_literal_matches_wire(&ready, SessionReady::validate);
        assert_literal_matches_wire(&start, SessionStart::validate);
        assert_literal_matches_wire(&input, SessionControl::validate);
        assert_literal_matches_wire(&event, SessionEvent::validate);
    }
}

#[test]
fn handshake_rejects_unknown_missing_and_duplicate_fields() {
    assert_required_and_closed::<SessionOpen>(
        json!({"protocol_version": 5, "session_id": "s", "command": "open", "operation": "terminal", "input": null}),
        &[
            "protocol_version",
            "session_id",
            "command",
            "operation",
            "input",
        ],
    );
    assert_required_and_closed::<SessionReady>(
        json!({"protocol_version": 5, "session_id": "s", "command": "ready"}),
        &["protocol_version", "session_id", "command"],
    );
    assert_required_and_closed::<SessionStart>(
        json!({"protocol_version": 5, "session_id": "s", "command": "start", "remaining_timeout_ns": 0}),
        &[
            "protocol_version",
            "session_id",
            "command",
            "remaining_timeout_ns",
        ],
    );
    assert!(serde_json::from_str::<SessionOpen>(r#"{"protocol_version":5,"session_id":"s","command":"open","operation":"terminal","input":null,"input":null}"#).is_err());
    assert!(
        serde_json::from_str::<SessionReady>(
            r#"{"protocol_version":5,"session_id":"s","session_id":"s","command":"ready"}"#
        )
        .is_err()
    );
    assert!(serde_json::from_str::<SessionStart>(r#"{"protocol_version":5,"session_id":"s","command":"start","remaining_timeout_ns":0,"remaining_timeout_ns":0}"#).is_err());
}

#[test]
fn handshake_commands_are_exact_strings() {
    for command in [json!("wrong"), json!({"open": null}), json!(0), Value::Null] {
        assert!(serde_json::from_value::<SessionOpen>(json!({"protocol_version": 5, "session_id": "s", "command": command, "operation": "terminal", "input": null})).is_err());
    }
    for command in [
        json!("start"),
        json!({"ready": null}),
        json!([]),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<SessionReady>(
                json!({"protocol_version": 5, "session_id": "s", "command": command})
            )
            .is_err()
        );
    }
    for command in [
        json!("ready"),
        json!({"start": null}),
        json!(true),
        Value::Null,
    ] {
        assert!(serde_json::from_value::<SessionStart>(json!({"protocol_version": 5, "session_id": "s", "command": command, "remaining_timeout_ns": 0})).is_err());
    }
}

#[test]
fn input_preserves_empty_raw_bytes_and_chunk_boundary() {
    for bytes in [
        Vec::new(),
        vec![0, 255, 128, 192],
        vec![255; SESSION_CHUNK_LIMIT],
    ] {
        let input = SessionControl::Input {
            protocol_version: 5,
            session_id: "s".into(),
            bytes: bytes.clone(),
        };
        assert!(input.validate().is_ok());
        assert_literal_matches_wire(&input, SessionControl::validate);
        let wire =
            json!({"protocol_version": 5, "session_id": "s", "command": "input", "bytes": bytes});
        assert_eq!(serde_json::to_value(&input).unwrap(), wire);
        let parsed: SessionControl = serde_json::from_value(wire).unwrap();
        match parsed {
            SessionControl::Input {
                bytes: received, ..
            } => assert_eq!(received, bytes),
            _ => panic!("空字节块和原字节必须保持 input 变体"),
        }
    }
    let input = SessionControl::Input {
        protocol_version: 5,
        session_id: "s".into(),
        bytes: vec![0; SESSION_CHUNK_LIMIT + 1],
    };
    assert!(input.validate().is_err());
    assert_literal_matches_wire(&input, SessionControl::validate);
}

#[test]
fn byte_arrays_reject_non_u8_and_non_array_values() {
    for bytes in [
        json!([-1]),
        json!([256]),
        json!([1.5]),
        json!([null]),
        json!(["0"]),
        json!([true]),
        json!("bytes"),
        json!({}),
        Value::Null,
    ] {
        let control =
            json!({"protocol_version": 5, "session_id": "s", "command": "input", "bytes": bytes});
        let event = json!({"protocol_version": 5, "session_id": "s", "event": "output", "sequence": 1, "stream": "stdout", "bytes": bytes});
        assert!(serde_json::from_value::<SessionControl>(control).is_err());
        assert!(serde_json::from_value::<SessionEvent>(event).is_err());
    }
}

#[test]
fn eof_and_all_cancel_reasons_preserve_wire() {
    let eof = SessionControl::Eof {
        protocol_version: SESSION_PROTOCOL_VERSION,
        session_id: "s".into(),
    };
    assert_literal_matches_wire(&eof, SessionControl::validate);
    assert_eq!(
        serde_json::to_value(eof).unwrap(),
        json!({"protocol_version": 5, "session_id": "s", "command": "eof"})
    );
    for (reason, name) in [
        (CancelReason::Cancelled, "cancelled"),
        (CancelReason::Timeout, "timeout"),
        (CancelReason::TransportFailure, "transport_failure"),
    ] {
        let cancel = SessionControl::Cancel {
            protocol_version: 5,
            session_id: "s".into(),
            reason,
        };
        assert_literal_matches_wire(&cancel, SessionControl::validate);
        assert_eq!(
            serde_json::to_value(cancel).unwrap(),
            json!({"protocol_version": 5, "session_id": "s", "command": "cancel", "reason": name})
        );
    }
}

#[test]
fn controls_reject_unknown_missing_and_duplicate_fields() {
    assert_required_and_closed::<SessionControl>(
        json!({"protocol_version": 5, "session_id": "s", "command": "input", "bytes": []}),
        &["protocol_version", "session_id", "command", "bytes"],
    );
    assert_required_and_closed::<SessionControl>(
        json!({"protocol_version": 5, "session_id": "s", "command": "eof"}),
        &["protocol_version", "session_id", "command"],
    );
    assert_required_and_closed::<SessionControl>(
        json!({"protocol_version": 5, "session_id": "s", "command": "cancel", "reason": "cancelled"}),
        &["protocol_version", "session_id", "command", "reason"],
    );
    assert!(
        serde_json::from_str::<SessionControl>(
            r#"{"protocol_version":5,"session_id":"s","command":"input","bytes":[],"bytes":[]}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<SessionControl>(
            r#"{"protocol_version":5,"session_id":"s","command":"eof","command":"eof"}"#
        )
        .is_err()
    );
    assert!(serde_json::from_str::<SessionControl>(r#"{"protocol_version":5,"session_id":"s","command":"cancel","reason":"cancelled","reason":"timeout"}"#).is_err());
    assert!(
        serde_json::from_value::<SessionControl>(
            json!({"protocol_version": 5, "session_id": "s", "command": "eof", "bytes": []})
        )
        .is_err()
    );
}

#[test]
fn output_and_finished_preserve_stream_and_sequence_fields() {
    for (stream, name, sequence) in [
        (SessionStream::Stdout, "stdout", 1),
        (SessionStream::Stderr, "stderr", 2),
    ] {
        let event = SessionEvent::output("s", sequence, stream, vec![0, 255]);
        assert_literal_matches_wire(&event, SessionEvent::validate);
        assert_eq!(event.session_id(), "s");
        assert_eq!(event.sequence(), sequence);
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "protocol_version": 5, "session_id": "s", "event": "output",
                "sequence": sequence, "stream": name, "bytes": [0, 255],
            })
        );
    }
    let event = SessionEvent::finished("s", 3, success(CleanupOutcome::Failed));
    assert_literal_matches_wire(&event, SessionEvent::validate);
    assert_eq!(event.sequence(), 3);
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "protocol_version": 5, "session_id": "s", "event": "finished",
            "sequence": 3, "outcome": {"result": null, "cleanup": "failed"},
        })
    );
}

#[test]
fn output_chunk_and_positive_sequence_have_literal_parity() {
    for length in [0, SESSION_CHUNK_LIMIT, SESSION_CHUNK_LIMIT + 1] {
        let event = SessionEvent::output("s", 1, SessionStream::Stdout, vec![0; length]);
        assert_eq!(event.validate().is_ok(), length <= SESSION_CHUNK_LIMIT);
        assert_literal_matches_wire(&event, SessionEvent::validate);
    }
    for sequence in [0, 1, u64::MAX] {
        let output = SessionEvent::output("s", sequence, SessionStream::Stdout, Vec::new());
        let finished = SessionEvent::finished("s", sequence, success(CleanupOutcome::Complete));
        assert_eq!(output.validate().is_ok(), sequence != 0);
        assert_eq!(finished.validate().is_ok(), sequence != 0);
        assert_literal_matches_wire(&output, SessionEvent::validate);
        assert_literal_matches_wire(&finished, SessionEvent::validate);
    }
    for sequence in [json!(-1), json!(1.5), json!("1"), Value::Null] {
        assert!(serde_json::from_value::<SessionEvent>(json!({"protocol_version": 5, "session_id": "s", "event": "output", "sequence": sequence, "stream": "stdout", "bytes": []})).is_err());
    }
}

#[test]
fn events_and_nested_outcome_reject_unknown_missing_and_duplicate_fields() {
    assert_required_and_closed::<SessionEvent>(
        json!({"protocol_version": 5, "session_id": "s", "event": "output", "sequence": 1, "stream": "stdout", "bytes": []}),
        &[
            "protocol_version",
            "session_id",
            "event",
            "sequence",
            "stream",
            "bytes",
        ],
    );
    assert_required_and_closed::<SessionEvent>(
        json!({"protocol_version": 5, "session_id": "s", "event": "finished", "sequence": 1, "outcome": {"result": null, "cleanup": "complete"}}),
        &[
            "protocol_version",
            "session_id",
            "event",
            "sequence",
            "outcome",
        ],
    );
    assert_required_and_closed::<SessionOutcome>(
        json!({"result": null, "cleanup": "complete"}),
        &["result", "cleanup"],
    );
    assert!(serde_json::from_str::<SessionEvent>(r#"{"protocol_version":5,"session_id":"s","event":"output","sequence":1,"sequence":2,"stream":"stdout","bytes":[]}"#).is_err());
    assert!(serde_json::from_str::<SessionEvent>(r#"{"protocol_version":5,"session_id":"s","event":"finished","sequence":1,"outcome":{"result":null,"cleanup":"complete","cleanup":"failed"}}"#).is_err());
    assert!(
        serde_json::from_str::<SessionOutcome>(
            r#"{"result":null,"result":null,"cleanup":"complete"}"#
        )
        .is_err()
    );
    assert!(serde_json::from_value::<SessionEvent>(json!({"protocol_version": 5, "session_id": "s", "event": "finished", "sequence": 1, "outcome": {"result": null, "cleanup": "complete", "unexpected": null}})).is_err());
}

#[test]
fn outcome_keeps_explicit_null_and_both_cleanup_results() {
    for cleanup in [CleanupOutcome::Complete, CleanupOutcome::Failed] {
        let outcome = success(cleanup);
        assert_literal_matches_wire(&outcome, SessionOutcome::validate);
        let wire = serde_json::to_value(outcome).unwrap();
        assert_eq!(wire["result"], Value::Null);
        assert!(wire.get("error").is_none());
        assert!(wire.get("outputs").is_none());
        let parsed: SessionOutcome = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed.result, Some(Value::Null));
        assert_eq!(parsed.cleanup, cleanup);
    }
    let parsed: SessionOutcome =
        serde_json::from_value(json!({"result": null, "error": null, "cleanup": "complete"}))
            .unwrap();
    assert_eq!(parsed.result, Some(Value::Null));
    assert!(parsed.error.is_none());
}

#[test]
fn outcome_requires_exactly_one_result_or_error() {
    for outcome in [
        SessionOutcome {
            result: None,
            error: None,
            outputs: Vec::new(),
            cleanup: CleanupOutcome::Complete,
        },
        SessionOutcome {
            result: Some(Value::Null),
            error: Some("失败".into()),
            outputs: Vec::new(),
            cleanup: CleanupOutcome::Failed,
        },
    ] {
        assert!(outcome.validate().is_err());
        assert_literal_matches_wire(&outcome, SessionOutcome::validate);
    }
    assert!(
        serde_json::from_value::<SessionOutcome>(json!({"error": null, "cleanup": "complete"}))
            .is_err()
    );
}

#[test]
fn outcome_error_is_nonblank_and_bounded_by_utf8_bytes() {
    let boundary = format!("{}a", "错".repeat(1365));
    assert_eq!(boundary.len(), 4096);
    for (error, valid) in [
        (String::new(), false),
        (" \t\n　".into(), false),
        ("失败".into(), true),
        (boundary.clone(), true),
        (format!("{boundary}b"), false),
    ] {
        let outcome = SessionOutcome {
            result: None,
            error: Some(error),
            outputs: Vec::new(),
            cleanup: CleanupOutcome::Failed,
        };
        assert_eq!(outcome.validate().is_ok(), valid);
        assert_literal_matches_wire(&outcome, SessionOutcome::validate);
    }
}

#[test]
fn failure_cannot_publish_artifacts_but_success_preserves_them() {
    for (result, error, valid) in [
        (Some(json!({"done": true})), None, true),
        (None, Some("失败".into()), false),
    ] {
        let outcome = SessionOutcome {
            result,
            error,
            outputs: vec![ArtifactOutput {
                filename: "result.bin".into(),
            }],
            cleanup: CleanupOutcome::Complete,
        };
        assert_eq!(outcome.validate().is_ok(), valid);
        assert_literal_matches_wire(&outcome, SessionOutcome::validate);
        if valid {
            assert_eq!(
                serde_json::to_value(outcome).unwrap()["outputs"],
                json!([{"filename": "result.bin"}])
            );
        }
    }
    assert!(serde_json::from_value::<SessionOutcome>(json!({"result": null, "cleanup": "complete", "outputs": [{"filename": "result.bin", "path": "private"}]})).is_err());
}

#[test]
fn output_stream_rejects_non_string_unit_enum_forms() {
    for stream in [
        json!({"stdout": null}),
        json!({"stderr": null}),
        json!("combined"),
        json!(0),
        json!([]),
        Value::Null,
    ] {
        assert!(serde_json::from_value::<SessionStream>(stream.clone()).is_err());
        let event = json!({"protocol_version": 5, "session_id": "s", "event": "output", "sequence": 1, "stream": stream, "bytes": []});
        assert!(serde_json::from_value::<SessionEvent>(event).is_err());
    }
}

#[test]
fn session_cancel_reason_rejects_non_string_unit_enum_forms() {
    for reason in [
        json!({"cancelled": null}),
        json!({"timeout": null}),
        json!({"transport_failure": null}),
        json!("unknown"),
        json!(0),
        json!([]),
        Value::Null,
    ] {
        let control = json!({"protocol_version": 5, "session_id": "s", "command": "cancel", "reason": reason});
        assert!(serde_json::from_value::<SessionControl>(control).is_err());
    }
}

#[test]
fn session_cleanup_rejects_non_string_unit_enum_forms() {
    for cleanup in [
        json!({"complete": null}),
        json!({"failed": null}),
        json!("unknown"),
        json!(0),
        json!([]),
        Value::Null,
    ] {
        let outcome = json!({"result": null, "cleanup": cleanup});
        assert!(serde_json::from_value::<SessionOutcome>(outcome.clone()).is_err());
        let event = json!({"protocol_version": 5, "session_id": "s", "event": "finished", "sequence": 1, "outcome": outcome});
        assert!(serde_json::from_value::<SessionEvent>(event).is_err());
    }
}

#[test]
fn old_manifest_wire_does_not_gain_session_declarations() {
    for version in 1..=4 {
        let wire = json!({
            "id": "legacy-terminal", "version": "0.1.0", "protocol_version": version,
            "executable": "legacy-terminal", "args": [],
            "operations": [{"name": "run", "title": "旧任务", "input_schema": {"type": "object"}}],
        });
        let manifest: Manifest = serde_json::from_value(wire.clone()).unwrap();
        assert!(manifest.artifacts.is_none());
        assert!(manifest.performance.is_none());
        assert!(manifest.devices.is_none());
        assert_eq!(serde_json::to_value(manifest).unwrap(), wire);
        let mut unsupported = wire;
        unsupported
            .as_object_mut()
            .unwrap()
            .insert("session".into(), json!({"protocol_version": 5}));
        assert!(serde_json::from_value::<Manifest>(unsupported).is_err());
    }
}
