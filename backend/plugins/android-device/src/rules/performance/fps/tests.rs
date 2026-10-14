//! 独立展示窗口文本回归，不使用 SAS 算法或模拟固定刷新率。
use super::*;

const PACKAGE: &str = "com.example.game";
const LAYER: &str = "SurfaceView[com.example.game/.Game](BLAST)#17";

fn check() -> Result<()> {
    Ok(())
}

fn layer() -> Layer {
    Layer {
        name: LAYER.into(),
        sdk: 30,
        pid: 123,
        uid: 10001,
        window: None,
        chain: vec![owner::Record {
            id: 17,
            name: LAYER.into(),
            parent: Some(-1),
            uid: Some(10001),
            has_metadata: true,
            metadata_uid: Some(10001),
            metadata_pid: Some(123),
        }],
    }
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
    assert!(belongs_to_package(LAYER, PACKAGE));
    for name in [
        "SurfaceView[com.example.games/.Main]#1",
        "SurfaceView[org.other/com.example.game.Main]#1",
    ] {
        assert!(!belongs_to_package(name, PACKAGE));
    }
}
#[test]
fn layer_name_is_raw_data_for_the_shared_transport_boundary() {
    let mut selected = layer();
    selected.name.push_str(" 'quoted'; $(data)");
    assert_eq!(selected.name(), format!("{LAYER} 'quoted'; $(data)"));
}

#[test]
fn sdk_requires_one_positive_decimal_device_property() {
    assert_eq!(sdk("28\r\n", &check).unwrap(), Some(28));
    for value in ["", "0", "unknown", "28 30", "28\n30", "-28", "4294967296"] {
        assert!(sdk(value, &check).unwrap().is_none(), "{value}");
    }
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
fn window_counts_only_new_presents_using_monotonic_sampling_duration() {
    let before = points(&[1_000_000_000, 1_016_000_000]);
    let after = points(&[1_000_000_000, 1_016_000_000, 1_032_000_000, 1_048_000_000]);
    let result = window(&layer(), &before, &after, 80_000_000, &check)
        .unwrap()
        .unwrap();
    // 历史跨度只有 32ms；分母必须保留调用者真实采样的 80ms。
    assert_eq!((result.frames, result.duration_ms), (2, 80));
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
    assert_ne!(result.source, other.source());
    other = layer();
    other.sdk = 28;
    assert_ne!(result.source, other.source());
}

#[test]
fn missing_anchor_rollback_and_empty_history_remain_absent() {
    let before = points(&[1_000_000_000, 1_016_000_000]);
    for after in [
        points(&[1_032_000_000, 1_048_000_000]),
        points(&[1_000_000_000]),
        points(&[]),
    ] {
        assert!(
            window(&layer(), &before, &after, 80_000_000, &check)
                .unwrap()
                .is_none()
        );
    }
    assert!(
        window(&layer(), &points(&[]), &points(&[1]), 80_000_000, &check)
            .unwrap()
            .is_none()
    );
}

#[test]
fn unchanged_valid_history_is_zero_fps_but_pending_or_empty_is_missing() {
    let before = points(&[1_000_000_000, 1_016_000_000]);
    for after in [
        points(&[1_000_000_000, 1_016_000_000]),
        points(&[1_016_000_000, 1_016_000_000]),
    ] {
        let result = window(&layer(), &before, &after, 80_000_000, &check)
            .unwrap()
            .unwrap();
        assert_eq!((result.frames, result.duration_ms), (0, 80));
    }
    let unavailable = points(&[0, i64::MAX as u64]);
    assert!(
        window(&layer(), &unavailable, &unavailable, 80_000_000, &check)
            .unwrap()
            .is_none()
    );
}

#[test]
fn elapsed_and_integer_millisecond_public_bounds_are_checked() {
    let before = points(&[1_000_000_000]);
    let after = points(&[1_000_000_000, 1_016_000_000]);
    let exact = window(&layer(), &before, &after, 60_000_000_000, &check)
        .unwrap()
        .unwrap();
    assert_eq!((exact.frames, exact.duration_ms), (1, 60_000));
    for elapsed in [0, 60_000_000_001, u64::MAX] {
        assert!(
            window(&layer(), &before, &after, elapsed, &check)
                .unwrap()
                .is_none()
        );
    }
    let rounded = window(&layer(), &before, &after, 1_000_001, &check)
        .unwrap()
        .unwrap();
    assert_eq!(rounded.duration_ms, 2);
    assert!(
        window(
            &layer(),
            &before,
            &points(&[1_000_000_000, 1_000_000_001, 1_000_000_002]),
            1,
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
    let result = window(&layer(), &before, &after, 80_000_000, &check)
        .unwrap()
        .unwrap();
    assert_eq!((result.frames, result.duration_ms), (1, 80));
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
        window(
            &layer(),
            &points(&[1]),
            &points(&[1, 2]),
            80_000_000,
            &cancelled
        ),
        Err(Error::Cancelled)
    ));
}
