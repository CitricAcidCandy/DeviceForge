use super::*;
use std::{path::PathBuf, sync::OnceLock};

fn tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let executable = dir.path().join(if cfg!(windows) {
                "input-tool.exe"
            } else {
                "input-tool"
            });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/device_input/fixtures/input-tool.rs");
            let output = std::process::Command::new("rustc")
                .arg(source)
                .arg("-o")
                .arg(&executable)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (dir, executable.to_string_lossy().into_owned())
        })
        .1
}
fn request(mode: &str, action: InputAction) -> (tempfile::TempDir, InputRequest) {
    let directory = tempfile::Builder::new()
        .prefix(&format!("{mode}."))
        .tempdir()
        .unwrap();
    let device_id = directory
        .path()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    (directory, InputRequest { device_id, action })
}
fn tap() -> InputAction {
    InputAction::Tap { x: 17, y: 42 }
}
#[tokio::test]
async fn real_input_process_preserves_text_and_orders_enter() {
    let text = " spaces  'quote' \"double\" $() `tick` \\ ; & | < > %s %%s % ";
    let (directory, request) = request(
        "text",
        InputAction::Text {
            text: text.into(),
            enter: true,
        },
    );
    let result = AndroidInput::new(tool().into())
        .dispatch(request, CancellationToken::new())
        .await
        .unwrap();
    assert!(result.dispatched);
    assert_eq!(result.action, "text");
    assert_eq!(
        std::fs::read_to_string(directory.path().join("observed")).unwrap(),
        format!("{text}<66>")
    );
    assert_eq!(text_arguments(&"%s".repeat(512)).len(), 513);
}
#[tokio::test]
async fn real_input_process_uses_numeric_coordinates_and_key_flags() {
    for (action, expected) in [
        (tap(), "tap:17,42\n"),
        (
            InputAction::Swipe {
                x1: 0,
                y1: 32767,
                x2: 42,
                y2: 8,
                duration_ms: 10000,
            },
            "swipe:0,32767,42,8,10000\n",
        ),
        (
            InputAction::Keyevent {
                key_code: 4,
                long_press: true,
            },
            "<--longpress,4>",
        ),
        (
            InputAction::Keyevent {
                key_code: 66,
                long_press: false,
            },
            "<66>",
        ),
    ] {
        let (directory, request) = request("numeric", action);
        AndroidInput::new(tool().into())
            .dispatch(request, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.path().join("observed")).unwrap(),
            expected
        );
    }
}
#[tokio::test]
async fn diagnostics_nonzero_exit_and_invalid_inputs_never_succeed() {
    let adapter = AndroidInput::new(tool().into());
    for mode in ["stdout", "stderr", "exit"] {
        let (_directory, request) = request(mode, tap());
        assert!(matches!(
            adapter.dispatch(request, CancellationToken::new()).await,
            Err(Error::Dependency(_))
        ));
    }
    for action in [
        InputAction::Tap { x: 32768, y: 0 },
        InputAction::Swipe {
            x1: 0,
            y1: 0,
            x2: 0,
            y2: 0,
            duration_ms: 0,
        },
        InputAction::Keyevent {
            key_code: 0,
            long_press: false,
        },
        InputAction::Text {
            text: "中文".into(),
            enter: false,
        },
        InputAction::Text {
            text: "a\nb".into(),
            enter: false,
        },
        InputAction::Text {
            text: "a".repeat(1025),
            enter: false,
        },
    ] {
        let (directory, request) = request("invalid", action);
        assert!(matches!(
            adapter.dispatch(request, CancellationToken::new()).await,
            Err(Error::Invalid(_))
        ));
        assert!(!directory.path().join("observed").exists());
    }
    assert!(
        InputRequest {
            device_id: "-s".into(),
            action: tap()
        }
        .validate()
        .is_err()
    );
}
#[tokio::test]
async fn timeout_and_running_cancellation_stop_input_before_enter() {
    let adapter = AndroidInput::new(tool().into());
    let (directory, request) = request(
        "slow",
        InputAction::Text {
            text: "first".into(),
            enter: true,
        },
    );
    assert!(matches!(
        adapter
            .dispatch_with_timeout(
                request,
                CancellationToken::new(),
                Duration::from_millis(100)
            )
            .await,
        Err(Error::Timeout)
    ));
    // 总期限包含进程启动；超时时可能尚未输入，也可能已经输入首段。
    let observed =
        std::fs::read_to_string(directory.path().join("observed")).unwrap_or_else(|error| {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
            String::new()
        });
    assert!(["", "first"].contains(&observed.as_str()));
    let (directory, request) = self::request(
        "slow",
        InputAction::Text {
            text: "first".into(),
            enter: true,
        },
    );
    let cancel = CancellationToken::new();
    let child_cancel = cancel.clone();
    let execution = tokio::spawn(async move { adapter.dispatch(request, child_cancel).await });
    let readiness = tokio::time::timeout(Duration::from_secs(10), async {
        while std::fs::read_to_string(directory.path().join("observed")).unwrap_or_default()
            != "first"
        {
            if execution.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    cancel.cancel();
    let result = execution.await.unwrap();
    readiness.expect("应在期限内观测到输入探针启动");
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "运行中取消失败：{result:?}"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("observed")).unwrap(),
        "first"
    );
}

#[tokio::test]
async fn per_device_lock_is_bounded_cancellable_and_does_not_block_other_devices() {
    let adapter = AndroidInput::new(tool().into());
    let (directory, request) = request("locked", tap());
    let lock = adapter.device_lock(&request.device_id).unwrap();
    assert!(Arc::ptr_eq(
        &lock,
        &adapter.device_lock(&request.device_id).unwrap()
    ));
    let guard = lock.lock().await;
    assert!(matches!(
        adapter
            .dispatch_with_timeout(
                request.clone(),
                CancellationToken::new(),
                Duration::from_millis(20)
            )
            .await,
        Err(Error::Timeout)
    ));
    let cancel = CancellationToken::new();
    let cancel_signal = cancel.clone();
    let (result, ()) = tokio::join!(adapter.dispatch(request.clone(), cancel), async {
        tokio::time::sleep(Duration::from_millis(5)).await;
        cancel_signal.cancel();
    });
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(!directory.path().join("observed").exists());
    let (_other_directory, other_request) = self::request("other", tap());
    assert!(
        adapter
            .dispatch(other_request, CancellationToken::new())
            .await
            .unwrap()
            .dispatched
    );
    drop(guard);
    drop(lock);
    assert!(
        adapter
            .dispatch(request, CancellationToken::new())
            .await
            .unwrap()
            .dispatched
    );
    let _next = adapter.device_lock("next-device").unwrap();
    assert_eq!(adapter.devices.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn remote_quote_roundtrips_through_a_real_posix_shell() {
    let text = " spaced 'quote' \"double\" $(printf injected) `printf injected` \\ ; & | < > ";
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("printf '%s' {}", quote(text)))
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout, text.as_bytes());
}
