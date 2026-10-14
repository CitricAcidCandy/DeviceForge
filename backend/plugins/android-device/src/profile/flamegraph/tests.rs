use super::*;
use crate::profile::report::{StackFrame, model::Unwinding};
use std::sync::atomic::{AtomicUsize, Ordering};

fn frame(file: Option<&str>, symbol: Option<&str>, address: &str) -> StackFrame {
    StackFrame {
        file: file.map(str::to_owned),
        symbol: symbol.map(str::to_owned),
        address: address.into(),
        execution_type: "native".into(),
    }
}
fn sample(chain: Vec<StackFrame>) -> StackSample {
    StackSample {
        time_ns: "9007199254740993".into(),
        thread_id: 2,
        process_id: Some(1),
        thread_name: Some("线程".into()),
        event_count: "1".into(),
        event_type: Some("cpu-clock".into()),
        callchain: chain,
        unwinding: None,
    }
}
fn report(samples: Vec<StackSample>) -> Report {
    Report {
        reported_sample_count: samples.len() as u64,
        samples,
        lost_count: 0,
        events: vec!["cpu-clock".into()],
    }
}
fn label(symbol: &str, file: &str) -> String {
    serde_json::to_string(&("native", Some(file), Some(symbol), Option::<&str>::None)).unwrap()
}
fn lines(folded: &Folded) -> Vec<&str> {
    folded.text.lines().collect()
}

#[test]
fn folded_reverses_and_merges_symbols_without_merging_modules() {
    let input = report(vec![
        sample(vec![
            frame(Some("a.so"), Some("leaf"), "0x1"),
            frame(Some("a.so"), Some("root"), "0x2"),
        ]),
        sample(vec![
            frame(Some("a.so"), Some("leaf"), "0x3"),
            frame(Some("a.so"), Some("root"), "0x4"),
        ]),
        sample(vec![
            frame(Some("b.so"), Some("leaf"), "0x1"),
            frame(Some("a.so"), Some("root"), "0x2"),
        ]),
    ]);
    let value = folded(&input, &Options::default(), &|| Ok(())).unwrap();
    assert_eq!(lines(&value).len(), 2);
    let key = format!(
        "event=\"cpu-clock\";pid=1;tid=2;{};{} 2",
        label("root", "a.so"),
        label("leaf", "a.so")
    );
    assert!(lines(&value).contains(&key.as_str()));
    assert_eq!(value.summary.total_weight, "3");
    assert_eq!(value.summary.drawn_weight, "3");
}

#[test]
fn folded_preserves_unknown_module_address_and_recursion() {
    let input = report(vec![
        sample(vec![
            frame(Some("a.so"), None, "0x1"),
            frame(Some("a.so"), Some("f"), "0x2"),
            frame(Some("a.so"), Some("f"), "0x3"),
        ]),
        sample(vec![frame(Some("a.so"), None, "0x2")]),
        sample(vec![frame(None, None, "0x1")]),
        sample(vec![frame(Some(""), Some(""), "0x1")]),
    ]);
    let value = folded(&input, &Options::default(), &|| Ok(())).unwrap();
    assert_eq!(lines(&value).len(), 4);
    let repeated = format!("{};{}", label("f", "a.so"), label("f", "a.so"));
    assert!(value.text.contains(&repeated));
    assert!(value.text.contains("[\"native\",\"a.so\",null,\"0x1\"]"));
    assert!(value.text.contains("[\"native\",null,null,\"0x1\"]"));
    assert_eq!(value.summary.quality.missing_symbol_frame_count, 4);
}

#[test]
fn folded_uses_half_open_u64_window_and_explicit_process_thread_filters() {
    let mut first = sample(vec![frame(None, None, "0x1")]);
    first.time_ns = "9007199254740992".into();
    let mut second = sample(vec![frame(None, None, "0x1")]);
    second.time_ns = "9007199254740993".into();
    let mut third = sample(vec![frame(None, None, "0x1")]);
    third.time_ns = "9007199254740994".into();
    let mut other = sample(vec![frame(None, None, "0x1")]);
    other.process_id = None;
    let input = report(vec![first, second, third, other]);
    let options = Options {
        process_id: Some(1),
        thread_id: Some(2),
        begin_ns: Some(9007199254740993),
        end_ns: Some(9007199254740994),
        ..Options::default()
    };
    let value = folded(&input, &options, &|| Ok(())).unwrap();
    assert_eq!(value.summary.included_sample_count, 1);
    assert!(value.text.ends_with(" 1\n"));
    let empty = folded(
        &input,
        &Options {
            thread_id: Some(99),
            ..Options::default()
        },
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(empty.text, "");
    assert_eq!(empty.summary.total_weight, "0");
}

#[test]
fn folded_accumulates_event_counts_beyond_u64_without_mixing_events() {
    let mut first = sample(vec![frame(None, None, "0x1")]);
    first.event_count = u64::MAX.to_string();
    let mut second = sample(vec![frame(None, None, "0x1")]);
    second.event_count = u64::MAX.to_string();
    let mut other = sample(vec![frame(None, None, "0x1")]);
    other.event_count = "7".into();
    other.event_type = Some("cycles".into());
    let input = report(vec![first, second, other]);
    let value = folded(
        &input,
        &Options {
            weight: Weight::EventCount,
            ..Options::default()
        },
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(
        value.summary.total_weight,
        (2 * u64::MAX as u128 + 7).to_string()
    );
    assert_eq!(lines(&value).len(), 2);
    assert!(value.text.contains(" 36893488147419103230\n"));
}

#[test]
fn folded_keeps_quality_and_empty_weight_without_inventing_frames() {
    let mut empty = sample(vec![]);
    empty.event_count = "9".into();
    let mut bad = sample(vec![frame(None, None, "0x1")]);
    bad.event_count = "7".into();
    bad.unwinding = Some(Unwinding {
        raw_error_code: Some(3),
        error_code: Some(0),
        error_address: None,
    });
    let input = report(vec![empty, bad]);
    let value = folded(
        &input,
        &Options {
            weight: Weight::EventCount,
            ..Options::default()
        },
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(lines(&value).len(), 1);
    assert_eq!(value.summary.included_sample_count, 2);
    assert_eq!(value.summary.drawn_sample_count, 1);
    assert_eq!(value.summary.total_weight, "16");
    assert_eq!(value.summary.drawn_weight, "7");
    assert_eq!(value.summary.empty_callchain_weight, "9");
    assert_eq!(value.summary.quality.empty_callchain_sample_count, 1);
    assert_eq!(
        value
            .summary
            .quality
            .unwinding_metadata_missing_sample_count,
        1
    );
    assert_eq!(value.summary.quality.unwinding_error_sample_count, 1);
    assert!(!value.text.contains("truncated"));
}

#[test]
fn folded_escapes_labels_without_colliding_with_literal_escape_text() {
    let mut first = sample(vec![frame(Some("库;\n%"), Some("f;\r\n%3B"), "0x1")]);
    first.event_type = None;
    first.process_id = None;
    let mut other = sample(vec![frame(Some("库%3B"), Some("f"), "0x1")]);
    other.event_type = Some("<unknown>".into());
    other.process_id = None;
    let input = report(vec![first, other]);
    let value = folded(&input, &Options::default(), &|| Ok(())).unwrap();
    assert_eq!(lines(&value).len(), 2);
    assert!(value.text.contains("event=null;pid=null;tid=2;"));
    assert!(value.text.contains("event=\"<unknown>\";pid=null;tid=2;"));
    assert!(value.text.contains("%3B"));
    assert!(value.text.contains("%253B"));
    assert!(!value.text.contains('\r'));
    let collected = lines(&value);
    assert!(
        collected
            .windows(2)
            .all(|pair| pair[0].as_bytes() < pair[1].as_bytes())
    );
}

#[test]
fn folded_rejects_bad_decimals_addresses_and_ranges() {
    for invalid in ["", "01", "-1", "18446744073709551616", "1.0"] {
        let mut source = sample(vec![]);
        source.time_ns = invalid.into();
        assert!(matches!(
            folded(&report(vec![source]), &Options::default(), &|| Ok(())),
            Err(Error::Invalid(_))
        ));
    }
    let mut source = sample(vec![]);
    source.event_count = "nan".into();
    assert!(matches!(
        folded(&report(vec![source]), &Options::default(), &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    let source = report(vec![sample(vec![frame(None, None, "0x10000000000000000")])]);
    assert!(matches!(
        folded(&source, &Options::default(), &|| Ok(())),
        Err(Error::Invalid(_))
    ));
    let options = Options {
        begin_ns: Some(2),
        end_ns: Some(1),
        ..Options::default()
    };
    assert!(matches!(
        folded(&report(vec![]), &options, &|| Ok(())),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn folded_checks_cancellation_during_label_generation_and_rejects_limits() {
    let source = report(vec![sample(vec![frame(
        Some("abcdefghijk"),
        Some("f"),
        "0x1",
    )])]);
    let calls = AtomicUsize::new(0);
    let value = folded(&source, &Options::default(), &|| {
        if calls.fetch_add(1, Ordering::Relaxed) == 15 {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    });
    assert!(matches!(value, Err(Error::Cancelled)));
    let depth = (0..=DEPTH_LIMIT)
        .map(|_| frame(None, None, "0x1"))
        .collect();
    assert!(matches!(
        folded(
            &report(vec![sample(depth)]),
            &Options::default(),
            &|| Ok(())
        ),
        Err(Error::TooLarge)
    ));
    let long = "a".repeat(FIELD_LIMIT + 1);
    assert!(matches!(
        folded(
            &report(vec![sample(vec![frame(Some(&long), None, "0x1")])]),
            &Options::default(),
            &|| Ok(())
        ),
        Err(Error::TooLarge)
    ));
    let many = (0..=SAMPLE_LIMIT).map(|_| sample(vec![])).collect();
    assert!(matches!(
        folded(&report(many), &Options::default(), &|| Ok(())),
        Err(Error::TooLarge)
    ));
}
