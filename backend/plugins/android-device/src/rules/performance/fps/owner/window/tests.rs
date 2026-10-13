//! 独立手工窗口与 Android 11 线格式，验证真实窗口身份桥接而非包名猜测。
use super::super::tests::{blob, integer, metadata};
use super::super::{Qualification, layer};
use super::*;
const PACKAGE: &str = "com.example.game";
const TITLE: &str = "com.example.game/.Game";
const SURFACE: &str = "com.example.game/.Game$_123";
const FRAME: &str = "SurfaceView - com.example.game/.Game@42@0#0";
const WINDOW: &str = "  Window #0 Window{ab12 u0 com.example.game/.Game}:\n    mSession=Session{cafe 123:u0a10001}\n    mOwnerUid=10001 package=com.example.game\n    mAppDied=false\n    mViewVisibility=0x0\n    mHasSurface=true isReadyForDisplay()=true\n      mSurface=Surface(name=com.example.game/.Game$_123)/@0x1234\n      mDrawState=HAS_DRAWN mLastHidden=false\n    isOnScreen=true\n    isVisible=true\n";
fn check() -> Result<()> {
    Ok(())
}
fn record(id: i32, name: &str, parent: i32, uid: Option<u32>) -> Vec<u8> {
    let mut data = integer(1, i64::from(id));
    data.extend(blob(2, name.as_bytes()));
    data.extend(integer(25, i64::from(parent)));
    if let Some(uid) = uid {
        data.extend(metadata(1, uid));
    }
    blob(1, &data)
}
fn data() -> Vec<u8> {
    [
        record(17, FRAME, 8, None),
        record(8, "Bounds for game#0", 7, None),
        record(7, &format!("{SURFACE}#0"), 3, Some(10001)),
        record(3, &format!("ab12 {TITLE}#0"), 1, None),
        record(1, "Root#0", -1, None),
    ]
    .concat()
}
fn selected(data: &[u8], output: &str) -> Option<super::super::super::Layer> {
    match layer(data, PACKAGE, 123, 10001, &check).unwrap() {
        Some(Qualification::Window(directory)) => directory.window_layer(output, &check).unwrap(),
        Some(Qualification::Owned(layer)) => Some(layer),
        None => None,
    }
}
#[test]
fn android11_window_session_and_native_parent_chain_are_one_exact_witness() {
    let result = selected(&data(), WINDOW).unwrap();
    assert_eq!(
        result
            .chain
            .iter()
            .map(|record| record.id)
            .collect::<Vec<_>>(),
        [17, 8, 7, 3, 1]
    );
    assert_eq!(result.window.as_ref().unwrap().token, "ab12");
    assert!(selected(&data(), &WINDOW.replace('\n', "\r\n")).is_some());
    let mut background = data();
    background.extend(record(18, &format!("Background for -{FRAME}"), 17, None));
    assert!(selected(&background, WINDOW).is_some());
    let mut background_blast = data();
    background_blast.extend(record(
        18,
        "Background for -SurfaceView - com.example.game/.Game(BLAST)#0",
        17,
        None,
    ));
    assert!(selected(&background_blast, WINDOW).is_some());
}
#[test]
fn another_pid_same_uid_background_surface_and_missing_or_changed_witness_are_rejected() {
    for (old, new) in [
        ("123:u0a10001", "124:u0a10001"),
        ("u0a10001", "u0a10002"),
        ("u0a10001", "u1a10001"),
        ("mOwnerUid=10001", "mOwnerUid=10002"),
        ("package=com.example.game", "package=com.example.games"),
        ("mHasSurface=true", "mHasSurface=false"),
        ("isReadyForDisplay()=true", "isReadyForDisplay()=false"),
        ("isOnScreen=true", "isOnScreen=false"),
        ("isVisible=true", "isVisible=false"),
        ("mViewVisibility=0x0", "mViewVisibility=0x8"),
        ("mAppDied=false", "mAppDied=true"),
        ("HAS_DRAWN", "NO_SURFACE"),
        ("mLastHidden=false", "mLastHidden=true"),
        ("Window{ab12", "Window{ab13"),
        ("$_123)", "$_124)"),
        ("mSession=Session{cafe 123:u0a10001}", ""),
        ("mSurface=Surface", "unknownSurface=Surface"),
    ] {
        assert!(
            selected(&data(), &WINDOW.replace(old, new)).is_none(),
            "{old}"
        );
    }
    assert!(selected(&data(), "").is_none());
    assert!(selected(&data(), &(WINDOW.to_owned() + WINDOW)).is_none());
    assert!(selected(&data(), &(WINDOW.to_owned() + "mOwnerUid=10001\n")).is_none());
}

#[test]
fn same_declared_surface_name_is_disambiguated_by_each_real_window_container_id() {
    let other = WINDOW
        .replace("Window #0", "Window #1")
        .replace("Window{ab12", "Window{cd34");
    let mut bytes = data();
    bytes.extend(record(4, &format!("cd34 {TITLE}#0"), 1, None));
    bytes.extend(record(9, &format!("{SURFACE}#1"), 4, Some(10001)));
    assert!(selected(&bytes, &(WINDOW.to_owned() + &other)).is_some());
    bytes.extend(record(19, &FRAME.replace("#0", "#1"), 9, None));
    assert!(selected(&bytes, &(WINDOW.to_owned() + &other)).is_none());
}
#[test]
fn duplicate_container_wrong_numeric_parent_and_uid_on_another_layer_cannot_bind() {
    let mut duplicate = data();
    duplicate.extend(record(4, &format!("ab12 {TITLE}#1"), 1, None));
    assert!(selected(&duplicate, WINDOW).is_none());
    let detached = [
        record(17, FRAME, 8, None),
        record(8, "Bounds for game#0", 7, None),
        record(7, &format!("{SURFACE}#0"), 4, Some(10001)),
        record(4, "another-window#0", 1, None),
        record(3, &format!("ab12 {TITLE}#0"), 1, None),
        record(1, "Root#0", -1, None),
    ]
    .concat();
    assert!(selected(&detached, WINDOW).is_none());
    for buffer_uid in [None, Some(10002)] {
        let shifted = [
            record(17, FRAME, 7, None),
            record(7, &format!("{SURFACE}#0"), 3, buffer_uid),
            record(3, &format!("ab12 {TITLE}#0"), 1, None),
            record(1, "Root#0", -1, Some(10001)),
        ]
        .concat();
        assert!(selected(&shifted, WINDOW).is_none());
    }
}
#[test]
fn window_session_and_surface_object_changes_invalidate_equality_and_source() {
    let result = selected(&data(), WINDOW).unwrap();
    for changed in [
        WINDOW.replace("Session{cafe", "Session{babe"),
        WINDOW.replace("/@0x1234", "/@0x5678"),
    ] {
        let changed = selected(&data(), &changed).unwrap();
        assert_ne!(result, changed);
        assert_ne!(result.source(), changed.source());
    }
}
#[test]
fn window_limits_and_original_context_failures_are_preserved() {
    for text in [
        "x".repeat(1024 * 1024 + 1),
        "\n".repeat(16_385),
        "x".repeat(4097),
        (1..=513)
            .map(|index| format!("  Window #{index} Window{{{index:x} u0 title}}:\n"))
            .collect::<String>(),
    ] {
        assert!(matches!(
            parse(&text, PACKAGE, 123, 10001, &check),
            Err(Error::TooLarge)
        ));
    }
    let cancelled = || Err(Error::Cancelled);
    assert!(matches!(
        parse(WINDOW, PACKAGE, 123, 10001, &cancelled),
        Err(Error::Cancelled)
    ));
    let timed_out = || Err(Error::Timeout);
    let Some(Qualification::Window(directory)) =
        layer(&data(), PACKAGE, 123, 10001, &check).unwrap()
    else {
        panic!("必须需要窗口见证");
    };
    assert!(matches!(
        directory.window_layer(WINDOW, &timed_out),
        Err(Error::Timeout)
    ));
}
