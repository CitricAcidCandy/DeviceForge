use super::*;
use crate::input::tests::with_control;
use apk_plugin_sdk::cooperative::CleanupOutcome;
use serde_json::Value;

#[tokio::test]
async fn missing_remote_confirmation_keeps_failed_cleanup_sticky_without_regranting_time() {
    with_control(|control| async move {
        drop(RemoteWaiting {
            control: &control,
            confirmed: false,
        });
        let first = control.lease.cleanup_point().unwrap();
        assert!(control.unresolved.load(Ordering::Acquire));
        assert!(matches!(control.check(), Err(Error::CleanupFailed)));
        drop(RemoteWaiting {
            control: &control,
            confirmed: false,
        });
        assert_eq!(control.lease.cleanup_point().unwrap(), first);
        assert_eq!(
            control.finish(Ok(Value::Null)).cleanup,
            CleanupOutcome::Failed
        );
    })
    .await;
}

#[tokio::test]
async fn confirmed_remote_frame_allows_business_failure_with_complete_cleanup() {
    with_control(|control| async move {
        drop(RemoteWaiting {
            control: &control,
            confirmed: true,
        });
        assert!(!control.unresolved.load(Ordering::Acquire));
        assert!(control.check().is_ok());
        let result = control.finish(Err(Error::Dependency("输入动作已结束但未成功")));
        assert!(result.outcome.is_err());
        assert_eq!(result.cleanup, CleanupOutcome::Complete);
    })
    .await;
}

#[tokio::test]
async fn precancelled_input_never_marks_remote_started() {
    with_control(|control| async move {
        control.context.cancellation().cancel();
        let result = run(
            &control,
            "HDC001",
            "0123456789abcdef0123456789abcdef",
            "action",
            "uitest help",
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!control.unresolved.load(Ordering::Acquire));
        assert_eq!(
            control.finish(result.map(|_| Value::Null)).cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

async fn capture_client(
    control: &Control,
    stdout: &str,
    stderr: &str,
    exit: i32,
) -> capture::Captured {
    let script = format!(
        "process.stdout.write({}); process.stderr.write({}); process.exitCode = {exit};",
        serde_json::to_string(stdout).unwrap(),
        serde_json::to_string(stderr).unwrap(),
    );
    capture::run(control, &["-e".into(), script]).await.unwrap()
}

#[tokio::test]
async fn nonzero_client_keeps_full_remote_receipt_and_reports_complete_business_failure() {
    with_control(|mut control| async move {
        control.executable = "node".into();
        let token = "0123456789abcdef0123456789abcdef";
        let frame = format!("No Error\n\nDF_INPUT_DONE:{token}:action:0\n");
        let captured = capture_client(&control, &frame, "", 7).await;
        assert_eq!(captured.status.code(), Some(7));
        assert_eq!(captured.stdout, frame.as_bytes());
        let mut waiting = RemoteWaiting {
            control: &control,
            confirmed: false,
        };
        let result = receive(&mut waiting, &captured, token, "action");
        assert!(matches!(
            result,
            Err(Error::Dependency("HDC客户端执行失败，请检查部署配置"))
        ));
        drop(waiting);
        assert!(control.check().is_ok());
        assert_eq!(
            control.finish(result.map(|_| Value::Null)).cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

#[tokio::test]
async fn nonzero_client_without_exact_remote_frame_keeps_cleanup_unconfirmed() {
    let token = "0123456789abcdef0123456789abcdef";
    for frame in [
        "No Error\n".to_owned(),
        format!("No Error\nDF_INPUT_DONE:{token}:action:0"),
        format!("No Error\nDF_INPUT_DONE:{token}:enter:0\n"),
        "No Error\nDF_INPUT_DONE:ffffffffffffffffffffffffffffffff:action:0\n".to_owned(),
        format!("DF_INPUT_DONE:{token}:action:0\nDF_INPUT_DONE:{token}:action:0\n"),
    ] {
        with_control(move |mut control| async move {
            control.executable = "node".into();
            let captured = capture_client(&control, &frame, "已结束", 7).await;
            assert_eq!(captured.status.code(), Some(7));
            let mut waiting = RemoteWaiting {
                control: &control,
                confirmed: false,
            };
            let result = receive(&mut waiting, &captured, token, "action");
            assert!(result.is_err());
            drop(waiting);
            let until = control.lease.cleanup_point().unwrap();
            assert_eq!(control.lease.cleanup_point().unwrap(), until);
            assert!(control.unresolved.load(Ordering::Acquire));
            assert_eq!(
                control.finish(result.map(|_| Value::Null)).cleanup,
                CleanupOutcome::Failed
            );
        })
        .await;
    }
}

#[tokio::test]
async fn failed_remote_status_with_exact_frame_keeps_cleanup_complete() {
    with_control(|mut control| async move {
        control.executable = "node".into();
        let token = "0123456789abcdef0123456789abcdef";
        let frame = format!("输入失败\nDF_INPUT_DONE:{token}:action:7\n");
        let captured = capture_client(&control, &frame, "", 0).await;
        assert!(captured.status.success());
        let mut waiting = RemoteWaiting {
            control: &control,
            confirmed: false,
        };
        let result = receive(&mut waiting, &captured, token, "action");
        assert!(matches!(
            result,
            Err(Error::Dependency("Harmony输入远端命令执行失败"))
        ));
        drop(waiting);
        assert_eq!(
            control.finish(result.map(|_| Value::Null)).cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

#[tokio::test]
async fn client_stderr_with_exact_remote_frame_keeps_cleanup_complete() {
    with_control(|mut control| async move {
        control.executable = "node".into();
        let token = "0123456789abcdef0123456789abcdef";
        let frame = format!("No Error\nDF_INPUT_DONE:{token}:action:0\n");
        let captured = capture_client(&control, &frame, "客户端诊断", 0).await;
        assert_eq!(captured.stderr, "客户端诊断".as_bytes());
        let mut waiting = RemoteWaiting {
            control: &control,
            confirmed: false,
        };
        let result = receive(&mut waiting, &captured, token, "action");
        assert!(matches!(
            result,
            Err(Error::Dependency("HDC输入客户端返回非空诊断"))
        ));
        drop(waiting);
        assert_eq!(
            control.finish(result.map(|_| Value::Null)).cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}
