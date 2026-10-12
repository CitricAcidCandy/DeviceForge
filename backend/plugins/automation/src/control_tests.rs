//! 通过真实工具进程验证正常保存、取消、期限与过早退出；不调用桌面输入。
use super::*;
use apk_plugin_sdk::{ReadyFrame, Request, StartFrame};
use deviceforge_plugin_runtime::{Execution, Output};
use std::{path::PathBuf, sync::OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn tool() -> &'static PathBuf {
    static TOOL: OnceLock<PathBuf> = OnceLock::new();
    TOOL.get_or_init(|| {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/automation-fixtures");
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(if cfg!(windows) {
            "record-tool.exe"
        } else {
            "record-tool"
        });
        let status = std::process::Command::new("rustc")
            .args(["--edition=2024", "tests/fixtures/record-tool.rs", "-o"])
            .arg(&executable)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(status.success());
        executable
    })
}

async fn exercise(kind: &'static str, timeout_ns: u64, duration: Duration) {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().to_owned();
    let executable = tool().to_str().unwrap().to_owned();
    let (client, server) = tokio::io::duplex(65536);
    let (server_read, server_write) = tokio::io::split(server);
    let worker = tokio::spawn(deviceforge_plugin_runtime::serve_io_with_context(
        server_read,
        server_write,
        move |_, context| async move {
            let cancellation = context.cancellation();
            let start_path = directory.join("started");
            let canceller = (kind == "cancel").then(|| {
                tokio::spawn(async move {
                    let until = Instant::now() + Duration::from_secs(3);
                    while !tokio::fs::try_exists(&start_path).await.unwrap() {
                        assert!(Instant::now() < until);
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    cancellation.cancel();
                })
            });
            let control = Control::new(context);
            let args = if kind == "early" {
                vec!["early".into()]
            } else {
                vec![]
            };
            let result = control
                .record_tool(&executable, &args, &directory, duration)
                .await;
            if let Some(canceller) = canceller {
                canceller.await.unwrap();
            }
            match kind {
                "normal" => assert!(result.is_ok(), "{result:?}"),
                "cancel" => assert!(matches!(result, Err(Error::Cancelled))),
                "timeout" => assert!(matches!(result, Err(Error::Timeout))),
                "early" => assert!(matches!(result, Err(Error::Tool(_)))),
                _ => unreachable!(),
            }
            if kind != "early" {
                assert_eq!(
                    tokio::fs::read(directory.join("saved")).await.unwrap(),
                    b"stdin_exit"
                );
            }
            control.finish(false).await.unwrap();
            Execution::complete(Ok(Output::from(serde_json::json!({"confirmed":true}))))
        },
    ));
    let (reader, mut writer) = tokio::io::split(client);
    let request = Request {
        protocol_version: 4,
        request_id: "record-test".into(),
        operation: "record".into(),
        input: serde_json::json!({}),
        artifacts: None,
    };
    writer
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    assert_eq!(
        serde_json::from_str::<ReadyFrame>(&line)
            .unwrap()
            .request_id,
        "record-test"
    );
    writer
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&StartFrame::new("record-test", timeout_ns)).unwrap()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    line.clear();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    worker.await.unwrap().unwrap();
}

#[tokio::test]
async fn normal_record_uses_stdin_exit_and_confirmed_cleanup() {
    exercise("normal", 3_000_000_000, Duration::from_millis(100)).await;
}
#[tokio::test]
async fn cancellation_saves_then_reports_cancelled() {
    exercise("cancel", 3_000_000_000, Duration::from_secs(5)).await;
}
#[tokio::test]
async fn original_deadline_allows_only_graceful_shutdown() {
    exercise("timeout", 300_000_000, Duration::from_secs(5)).await;
}
#[tokio::test]
async fn early_zero_exit_does_not_claim_full_recording() {
    exercise("early", 3_000_000_000, Duration::from_secs(1)).await;
}
