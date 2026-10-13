use super::*;
use apk_plugin_sdk::{ArtifactContext, ArtifactInput};
use std::{future::Future, io::Cursor};

mod publication;
mod receive;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const JPEG: &[u8] = &[
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63,
    0, 0x12, 0xff, 0, 0x34, 0xff, 0xd9,
];

async fn with_control<T, Work, WorkFuture>(work: Work) -> T
where
    T: Send + 'static,
    Work: FnOnce(Control) -> WorkFuture + Send + 'static,
    WorkFuture: Future<Output = T> + Send + 'static,
{
    use deviceforge_plugin_runtime::serve_io_with_context;
    use tokio::io::AsyncWriteExt;
    let (mut host, plugin) = tokio::io::duplex(4096);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let runtime = tokio::spawn(serve_io_with_context(
        plugin,
        tokio::io::sink(),
        move |_, context| async move {
            assert!(
                sender
                    .send(work(Control::new(context, "unused-hdc".into())).await)
                    .is_ok()
            );
            Execution::complete(Ok(Output::from(serde_json::Value::Null)))
        },
    ));
    host.write_all(b"{\"protocol_version\":4,\"request_id\":\"screenshot-library\",\"operation\":\"screenshot\",\"input\":{}}\n{\"protocol_version\":4,\"request_id\":\"screenshot-library\",\"command\":\"start\",\"remaining_timeout_ns\":30000000000}\n").await.unwrap();
    let result = receiver.await.unwrap();
    runtime.await.unwrap().unwrap();
    drop(host);
    result
}

#[test]
fn screenshot_requires_output_authorization_and_rejects_input_artifacts() {
    let mut request = Request {
        protocol_version: 4,
        request_id: "screenshot".into(),
        operation: "screenshot".into(),
        input: serde_json::json!({"device_id":"HDC001","input":{}}),
        artifacts: None,
    };
    assert_eq!(
        validate_context(&request).unwrap_err().to_string(),
        "输入无效：未获截图输出授权"
    );
    request.artifacts = Some(ArtifactContext {
        inputs: Vec::new(),
        output_directory: None,
    });
    assert!(validate_context(&request).is_err());
    let directory = tempfile::tempdir().unwrap();
    request.artifacts.as_mut().unwrap().output_directory =
        Some(directory.path().to_str().unwrap().into());
    assert_eq!(
        validate_context(&request).unwrap(),
        directory.path().join("screenshot.jpeg")
    );
    request
        .artifacts
        .as_mut()
        .unwrap()
        .inputs
        .push(ArtifactInput {
            field: "/input/artifact_id".into(),
            artifact_id: "unaccepted".into(),
            filename: "input.jpeg".into(),
            size: 1,
            sha256: "0".repeat(64),
            path: "unused".into(),
        });
    assert_eq!(
        validate_context(&request).unwrap_err().to_string(),
        "输入无效：截图不接受输入产物"
    );
}

#[test]
fn screenshot_scripts_use_only_qualified_token_and_independent_device_argument() {
    for template in [
        scripts::PROBE,
        scripts::CAPTURE,
        scripts::SIZE,
        scripts::READ,
        scripts::CLEAR,
    ] {
        let args = scripts::args("host:5555", template, TOKEN).unwrap();
        assert_eq!(&args[..3], ["-t", "host:5555", "shell"]);
        assert!(!args[3].contains("<token>"));
        assert!(args[3].contains(TOKEN));
    }
    for token in [
        "",
        "ABCDEF0123456789ABCDEF0123456789",
        "0123456789abcdef0123456789abcde;",
        "../owner",
    ] {
        assert!(scripts::args("HDC001", scripts::CAPTURE, token).is_err());
    }
    for device in ["-flag", "HDC001;id", "HDC001\n", "设备"] {
        assert!(scripts::args(device, scripts::CAPTURE, TOKEN).is_err());
    }
}

#[test]
fn terminal_receipts_require_unique_matching_last_line_and_canonical_status() {
    let normal = format!("diagnostic\nDF_READ_DONE:{TOKEN}:0\n");
    assert_eq!(
        rules::terminal(&normal, "DF_READ_DONE", TOKEN).unwrap(),
        "0"
    );
    for invalid in [
        normal.trim_end().to_owned(),
        format!("DF_READ_DONE:{TOKEN}:0\nlater\n"),
        format!("DF_READ_DONE:{TOKEN}:0\nDF_READ_DONE:{TOKEN}:0\n"),
        "DF_READ_DONE:other:0\n".into(),
    ] {
        assert!(rules::terminal(&invalid, "DF_READ_DONE", TOKEN).is_err());
    }
    for status in ["", "00", "+0", "-1", "256", " 0"] {
        assert!(rules::status(status).is_err());
    }
    assert_eq!(rules::status("255").unwrap(), 255);
}

#[test]
fn probe_capture_and_size_require_complete_platform_qualification() {
    let probe = format!("RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{TOKEN}:0\n");
    assert!(rules::probe(&probe, TOKEN, b"").is_ok());
    assert!(rules::probe(&probe.replace("\n", "\r\n"), TOKEN, b"").is_ok());
    assert!(rules::probe(&probe.replace("RGV2aWNlRm9yZ2U=", "wrong"), TOKEN, b"").is_err());
    let captured = format!(
        "DF_OWNER_READY:{TOKEN}\nsuccess: snapshot display 0 , write to {} as jpeg, width 1, height 1\nDF_CAPTURED:{TOKEN}:0\n",
        scripts::path(TOKEN)
    );
    assert!(rules::captured(&captured, TOKEN, b"", 0).is_ok());
    for invalid in [
        captured.replace("width 1", "width 0"),
        captured.replace("screenshot.jpeg", "other.jpeg"),
        captured.replace("DF_OWNER_READY", "DF_OTHER"),
        format!("{captured}success: snapshot display 0\n"),
    ] {
        assert!(rules::captured(&invalid, TOKEN, b"", 0).is_err());
    }
    assert_eq!(
        rules::captured(&captured, TOKEN, b"[Fail] denied", 0)
            .unwrap_err()
            .to_string(),
        "工具依赖失败：HDC返回失败诊断"
    );
    assert_eq!(rules::size(" 67108864 \r").unwrap(), models::FILE_LIMIT);
    for size in ["0", "-1", "+1", "1\n2", "67108865", "18446744073709551616"] {
        assert!(rules::size(size).is_err());
    }
}
