//! 独立展示窗口文本回归，不使用 SAS 算法或模拟固定刷新率。
use super::*;

const PACKAGE: &str = "com.example.game";
const LAYER: &str = "SurfaceView[com.example.game/.Game](BLAST)#17";

fn check() -> Result<()> {
    Ok(())
}

fn layer() -> Layer {
    Layer { name: LAYER.into(), pid: 123, uid: 10001, chain: vec![owner::Record {
        id: 17, name: LAYER.into(), parent: -1, uid: Some(10001),
        metadata_uid: Some(10001), metadata_pid: Some(123),
    }] }
}

fn text(points: &[u64]) -> String {
    let mut output = String::from("16666666\n");
    for actual in points {
        output.push_str(&format!("1 {actual} 2\n"));
    }
    output
}

fn points(points: &[u64]) -> Snapshot {
    snapshot(&text(points), &check).unwrap().unwrap()
}

#[test]
fn package_boundary_is_only_a_candidate_filter() {
    assert!(belongs_to_package(LAYER,PACKAGE));
    for name in ["SurfaceView[com.example.games/.Main]#1", "SurfaceView[org.other/com.example.game.Main]#1"] {
        assert!(!belongs_to_package(name,PACKAGE));
    }
}
#[test]
fn shell_quote_keeps_layer_name_as_one_data_argument() {
    let mut selected = layer();
    selected.name.push_str(" 'quoted'; $(data)");
    let quoted = selected.shell_argument();
    assert!(quoted.starts_with('\''));
    assert!(quoted.ends_with('\''));
    assert!(quoted.contains("'\\''"));
}

#[test]
fn timestamps_use_actual_column_skip_pending_and_deduplicate() {
    let pending = i64::MAX;
    let output =
        format!("16666666\n9 0 8\n7 1000000000 6\n5 1000000000 4\n3 {pending} 2\n1 1016000000 0\n");
    let captured = snapshot(&output, &check).unwrap().unwrap();
    assert_eq!(captured.present_ns, vec![1_000_000_000, 1_016_000_000]);
}

#[test]
fn unknown_or_malformed_latency_never_becomes_zero_fps() {
    for input in [
        "",
        "0\n",
        "16666666 extra\n",
        "unsupported\n",
        "16666666\n1 2\n",
        "16666666\n1 2 3 4\n",
        "16666666\n1 -2 3\n",
        "16666666\n1 9223372036854775808 3\n",
        "16666666\n1 2000000000 3\n1 1000000000 3\n",
    ] {
        assert!(snapshot(input, &check).unwrap().is_none(), "{input:?}");
    }
}

#[test]
fn window_counts_only_new_distinct_presents_and_has_stable_bounded_source() {
    let before = points(&[1_000_000_000, 1_016_000_000]);
    let after = points(&[1_000_000_000, 1_016_000_000, 1_032_000_000, 1_048_000_000]);
    let result = window(&layer(), &before, &after, &check).unwrap().unwrap();
    assert_eq!((result.frames, result.duration_ms), (2, 32));
    assert_eq!(result.source.len(), "sf_present_".len() + 16);
    assert!(
        result
            .source
            .strip_prefix("sf_present_")
            .unwrap()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    assert_eq!(result.source, layer().source());
    let mut other = layer();
    other.chain[0].id = 18;
    other.chain[0].name = LAYER.replace("#17", "#18");
    assert_ne!(result.source, other.source());
}

#[test]
fn missing_anchor_no_new_present_and_empty_history_are_absent() {
    let before = points(&[1_000_000_000, 1_016_000_000]);
    for after in [
        points(&[1_032_000_000, 1_048_000_000]),
        points(&[1_000_000_000, 1_016_000_000]),
        points(&[]),
        points(&[1_016_000_000, 1_016_000_000]),
    ] {
        assert!(window(&layer(), &before, &after, &check).unwrap().is_none());
    }
    assert!(
        window(&layer(), &points(&[]), &points(&[1]), &check)
            .unwrap()
            .is_none()
    );
}

#[test]
fn span_and_integer_millisecond_public_bounds_are_checked() {
    let before = points(&[1_000_000_000]);
    let exact = window(
        &layer(),
        &before,
        &points(&[1_000_000_000, 61_000_000_000]),
        &check,
    )
    .unwrap()
    .unwrap();
    assert_eq!((exact.frames, exact.duration_ms), (1, 60_000));
    assert!(
        window(
            &layer(),
            &before,
            &points(&[1_000_000_000, 61_000_000_001]),
            &check
        )
        .unwrap()
        .is_none()
    );
    let rounded = window(
        &layer(),
        &before,
        &points(&[1_000_000_000, 1_001_000_001]),
        &check,
    )
    .unwrap()
    .unwrap();
    assert_eq!(rounded.duration_ms, 2);
    assert!(
        window(
            &layer(),
            &before,
            &points(&[1_000_000_000, 1_000_000_001, 1_000_000_002]),
            &check
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn nanosecond_ticks_keep_integer_precision_near_signed_limit() {
    let anchor = i64::MAX as u64 - 20_000_000;
    let before = points(&[anchor]);
    let after = points(&[anchor, anchor + 16_000_000, i64::MAX as u64]);
    let result = window(&layer(), &before, &after, &check).unwrap().unwrap();
    assert_eq!((result.frames, result.duration_ms), (1, 16));
}

#[test]
fn row_limits_and_context_failures_propagate() {
    assert!(matches!(
        snapshot(
            &format!("16666666\n{}", "1 0 2\n".repeat(MAX_FRAME_ROWS + 1)),
            &check
        ),
        Err(Error::TooLarge)
    ));
    let cancelled = || Err(Error::Cancelled);
    assert!(matches!(
        snapshot(&text(&[1]), &cancelled),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        window(&layer(), &points(&[1]), &points(&[1, 2]), &cancelled),
        Err(Error::Cancelled)
    ));
}
