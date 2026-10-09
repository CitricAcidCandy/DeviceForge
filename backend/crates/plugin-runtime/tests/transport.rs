use apk_plugin_sdk::{Request, cooperative::*};
use deviceforge_plugin_runtime::{Execution, serve_io};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn request() -> Vec<u8> {
    let request = Request {
        protocol_version: 3,
        request_id: "request-1".into(),
        operation: "test".into(),
        input: json!({}),
        artifacts: None,
    };
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    bytes
}
async fn cancellation(frame: Option<Vec<u8>>) -> CooperativeResponse {
    let (host, plugin) = tokio::io::duplex(8192);
    let (reader, writer) = tokio::io::split(plugin);
    let cleaned = Arc::new(AtomicBool::new(false));
    let marker = cleaned.clone();
    let running = tokio::spawn(serve_io(reader, writer, move |_, cancel| async move {
        cancel.cancelled().await;
        marker.store(true, Ordering::Release);
        // 取消后即使业务返回成功，运行库也不得发布晚到成功。
        Execution::complete(Ok(json!({"late":true}).into()))
    }));
    let (mut read, mut write) = tokio::io::split(host);
    write.write_all(&request()).await.unwrap();
    if let Some(frame) = frame {
        write.write_all(&frame).await.unwrap();
    } else {
        write.shutdown().await.unwrap();
    }
    let mut bytes = Vec::new();
    read.read_to_end(&mut bytes).await.unwrap();
    running.await.unwrap().unwrap();
    assert!(cleaned.load(Ordering::Acquire));
    let reply: CooperativeResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reply.cleanup, CleanupOutcome::Complete);
    assert!(reply.response.result.is_none());
    assert!(reply.response.outputs.is_empty());
    reply
}
#[tokio::test]
async fn correct_cancel_and_eof_both_cleanup_and_reject_late_success() {
    let bytes = b"{\"protocol_version\":3,\"request_id\":\"request-1\",\"command\":\"cancel\",\"reason\":\"cancelled\"}\n";
    for frame in [Some(bytes.to_vec()), None] {
        assert!(
            cancellation(frame)
                .await
                .response
                .error
                .unwrap()
                .contains("取消")
        );
    }
}
#[tokio::test]
async fn malformed_mismatched_and_oversized_controls_trigger_cleanup_with_error() {
    for frame in [
        b"{\n".to_vec(),
        b"{\"protocol_version\":3,\"request_id\":\"wrong\",\"command\":\"cancel\",\"reason\":\"timeout\"}\n".to_vec(),
        vec![b'x'; CONTROL_LIMIT + 1],
    ] {
        assert!(cancellation(Some(frame)).await.response.error.is_some());
    }
}
#[tokio::test]
async fn unbounded_or_incomplete_initial_frames_never_invoke_handler() {
    for bytes in [
        vec![b'x'; REQUEST_LIMIT + 1],
        b"{}".to_vec(),
        b"{}\n".to_vec(),
    ] {
        let result = serve_io(bytes.as_slice(), tokio::io::sink(), |_, _| async {
            panic!("错误输入不得调用业务处理器")
        })
        .await;
        assert!(result.is_err());
    }
}
#[tokio::test]
async fn response_limit_and_explicit_failed_cleanup_are_preserved() {
    for failed in [false, true] {
        let mut output = Vec::new();
        serve_io(request().as_slice(), &mut output, move |_, _| async move {
            Execution {
                outcome: Ok(json!({"large":"x".repeat(RESPONSE_LIMIT)}).into()),
                cleanup: if failed {
                    CleanupOutcome::Failed
                } else {
                    CleanupOutcome::Complete
                },
            }
        })
        .await
        .unwrap();
        assert!(output.len() < RESPONSE_LIMIT);
        let reply: CooperativeResponse = serde_json::from_slice(&output).unwrap();
        assert_eq!(reply.cleanup == CleanupOutcome::Failed, failed);
        assert_eq!(reply.response.error.as_deref(), Some("响应超过 1 MiB"));
    }
}
