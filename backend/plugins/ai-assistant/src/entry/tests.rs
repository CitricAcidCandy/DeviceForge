use super::*;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

async fn call(frames: &[Value]) -> Vec<Value> {
    let (host, plugin) = tokio::io::duplex(65536);
    let (reader, mut writer) = tokio::io::split(host);
    let (plugin_reader, plugin_writer) = tokio::io::split(plugin);
    let runtime = tokio::spawn(serve_io(plugin_reader, plugin_writer));
    let mut wire = Vec::new();
    for frame in frames {
        wire.extend(serde_json::to_vec(frame).unwrap());
        wire.push(b'\n');
    }
    writer.write_all(&wire).await.unwrap();
    let mut reader = BufReader::new(reader);
    let mut result = Vec::new();
    loop {
        let mut line = String::new();
        if time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap()
            == 0
        {
            break;
        }
        result.push(serde_json::from_str(&line).unwrap());
    }
    runtime.await.unwrap().unwrap();
    result
}

#[tokio::test]
async fn protocol_four_ready_and_nested_cooperative_response_preserve_prebuffered_start() {
    let frames = call(&[
        json!({"protocol_version":4,"request_id":"old-case","operation":"unknown","input":{}}),
        json!({"protocol_version":4,"request_id":"old-case","command":"start","remaining_timeout_ns":10000000000u64}),
    ]).await;
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["command"], "ready");
    let response: apk_plugin_sdk::cooperative::CooperativeResponse =
        serde_json::from_value(frames[1].clone()).unwrap();
    assert_eq!(response.response.protocol_version, 4);
    assert_eq!(response.response.request_id, "old-case");
    assert!(response.response.error.is_some());
}

#[tokio::test]
async fn protocol_five_ready_and_finished_preserve_prebuffered_start_and_scope() {
    let frames = call(&[
        json!({"protocol_version":5,"session_id":"new-case","command":"open","operation":"unknown","input":{}}),
        json!({"protocol_version":5,"session_id":"new-case","command":"start","remaining_timeout_ns":10000000000u64}),
    ]).await;
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["command"], "ready");
    let response: apk_plugin_sdk::session::SessionEvent =
        serde_json::from_value(frames[1].clone()).unwrap();
    response.validate().unwrap();
    assert_eq!(frames[1]["event"], "finished");
    assert_eq!(frames[1]["outcome"]["cleanup"], "complete");
    assert_eq!(frames[1]["outcome"]["error"], "未知AI会话操作");
}

#[tokio::test]
async fn malformed_unsupported_and_oversized_first_frames_reject_without_output() {
    for raw in [
        b"not-json\n".to_vec(),
        b"{\"protocol_version\":3}\n".to_vec(),
        b"{\"protocol_version\":5.0}\n".to_vec(),
        vec![b'x'; 512 * 1024 + 1],
    ] {
        assert!(serve_io(Cursor::new(raw), tokio::io::sink()).await.is_err());
    }
}
