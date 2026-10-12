//! 黑盒插件进程只验证未启用桌面的拒绝路径，不派发实际系统输入。
use apk_plugin_sdk::{
    ReadyFrame, Request, StartFrame,
    cooperative::{CleanupOutcome, CooperativeResponse},
};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

async fn invoke(operation: &str, input: serde_json::Value) -> CooperativeResponse {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("automation.config.json");
    tokio::fs::write(&config, b"{\"format_version\":1,\"desktop_enabled\":false}")
        .await
        .unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_deviceforge-automation-plugin"));
    process
        .args(["--config"])
        .arg(config)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = process.spawn().unwrap();
    let mut writer = child.stdin.take().unwrap();
    let request = Request {
        protocol_version: 4,
        request_id: "disabled-desktop".into(),
        operation: operation.into(),
        input,
        artifacts: None,
    };
    writer
        .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
        .await
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        reader.read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::from_str::<ReadyFrame>(&line)
            .unwrap()
            .request_id,
        "disabled-desktop"
    );
    writer
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&StartFrame::new("disabled-desktop", 3_000_000_000)).unwrap()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    line.clear();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        reader.read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let response: CooperativeResponse = serde_json::from_str(&line).unwrap();
    drop(writer);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(response.cleanup, CleanupOutcome::Complete);
    assert_eq!(response.response.request_id, "disabled-desktop");
    assert!(response.response.error.is_some());
    response
}

#[tokio::test]
async fn desktop_and_trace_contributions_fail_before_system_input_when_not_enabled() {
    for (operation, input) in [
        ("windows.mouse.position", json!({})),
        (
            "windows.mouse.click",
            json!({"button":"left","click":"single"}),
        ),
        (
            "windows.mouse.repeat",
            json!({"button":"left","click":"single","interval_ms":10,"repeat":{"kind":"count","count":1}}),
        ),
        (
            "input_trace.record",
            json!({"event_type":0,"interval_ms":10,"duration_ms":100}),
        ),
        (
            "input_trace.playback",
            json!({"event_type":0,"artifact_id":"demo"}),
        ),
    ] {
        assert!(
            invoke(operation, input)
                .await
                .response
                .error
                .unwrap()
                .contains("本机桌面")
        );
    }
}

#[tokio::test]
async fn android_contribution_reports_missing_dependency_and_keeps_original_input_contract() {
    let reply = invoke(
        "click.repeat",
        json!({"device_id":"demo","x":1,"y":2,"count":1,"interval_ms":10}),
    )
    .await;
    assert!(reply.response.error.unwrap().contains("尚未配置ADB工具"));
}
