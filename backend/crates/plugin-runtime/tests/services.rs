use apk_plugin_sdk::{Request, cooperative::CleanupOutcome, services::*};
use deviceforge_plugin_runtime::{Execution, serve_io_with_services};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

async fn send(writer: &mut (impl AsyncWrite + Unpin), value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    writer.write_all(&bytes).await.unwrap();
}
async fn receive(reader: &mut (impl AsyncBufRead + Unpin)) -> Value {
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), reader.read_until(b'\n', &mut bytes))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
async fn start(
    reader: &mut (impl AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    budget: u64,
) {
    send(
        writer,
        json!({"protocol_version":6,"request_id":"root","operation":"compose","input":{}}),
    )
    .await;
    assert_eq!(receive(reader).await["command"], "ready");
    send(writer, json!({"command":"start","protocol_version":6,"request_id":"root","remaining_timeout_ns":budget})).await;
}

#[tokio::test]
async fn typed_handle_roundtrips_exact_version_and_null_before_final_cleanup() {
    let (host, plugin) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(plugin);
    let plugin = tokio::spawn(serve_io_with_services(
        reader,
        writer,
        |_: Request, _, services| async move {
            let echo = services.service::<Value, Value>(ServiceRef {
                id: "demo.echo".into(),
                version: "1.0".into(),
            });
            Execution::complete(echo.call(&json!({"value":1})).await.map(Into::into))
        },
    ));
    let (reader, mut writer) = tokio::io::split(host);
    let mut reader = BufReader::new(reader);
    start(&mut reader, &mut writer, 5_000_000_000).await;
    let call = receive(&mut reader).await;
    assert_eq!(call["command"], "service_call");
    assert_eq!(call["service"], json!({"id":"demo.echo","version":"1.0"}));
    send(&mut writer, json!({"command":"service_result","protocol_version":6,"request_id":"root","call_id":call["call_id"],"outcome":{"status":"succeeded","result":null}})).await;
    let finished: ServiceFrame = serde_json::from_value(receive(&mut reader).await).unwrap();
    match finished {
        ServiceFrame::Finished { execution, .. } => {
            assert_eq!(execution.cleanup, CleanupOutcome::Complete);
            assert_eq!(execution.response.result, Some(Value::Null));
        }
        _ => panic!("必须收到独立终态"),
    }
    plugin.await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn ready_wait_consumes_original_budget_without_starting_handler() {
    let (host, plugin) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(plugin);
    let called = Arc::new(AtomicBool::new(false));
    let observer = called.clone();
    let plugin = tokio::spawn(serve_io_with_services(
        reader,
        writer,
        move |_, _, _| async move {
            observer.store(true, Ordering::Release);
            Execution::complete(Ok(json!({}).into()))
        },
    ));
    let (reader, mut writer) = tokio::io::split(host);
    let mut reader = BufReader::new(reader);
    send(
        &mut writer,
        json!({"protocol_version":6,"request_id":"root","operation":"compose","input":{}}),
    )
    .await;
    receive(&mut reader).await;
    tokio::time::advance(Duration::from_millis(200)).await;
    send(&mut writer, json!({"command":"start","protocol_version":6,"request_id":"root","remaining_timeout_ns":100_000_000})).await;
    assert_eq!(
        receive(&mut reader).await["execution"]["cleanup"],
        "complete"
    );
    plugin.await.unwrap().unwrap();
    assert!(!called.load(Ordering::Acquire));
}

#[tokio::test]
async fn host_cancel_waits_for_handler_cleanup_and_returns_error_not_success() {
    let (host, plugin) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(plugin);
    let cleaned = Arc::new(AtomicBool::new(false));
    let observer = cleaned.clone();
    let (started, entered) = tokio::sync::oneshot::channel();
    let plugin = tokio::spawn(serve_io_with_services(
        reader,
        writer,
        move |_, context, _| async move {
            let _ = started.send(());
            context.cancellation().cancelled().await;
            observer.store(true, Ordering::Release);
            Execution::complete(Ok(json!({"late":true}).into()))
        },
    ));
    let (reader, mut writer) = tokio::io::split(host);
    let mut reader = BufReader::new(reader);
    start(&mut reader, &mut writer, 5_000_000_000).await;
    entered.await.unwrap();
    send(
        &mut writer,
        json!({"command":"cancel","protocol_version":6,"request_id":"root"}),
    )
    .await;
    let finished = receive(&mut reader).await;
    assert_eq!(finished["execution"]["cleanup"], "complete");
    assert!(finished["execution"]["response"].get("result").is_none());
    assert!(cleaned.load(Ordering::Acquire));
    plugin.await.unwrap().unwrap();
}

#[tokio::test]
async fn dropped_child_future_emits_service_cancel_not_http_fallback() {
    let (host, plugin) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(plugin);
    let plugin = tokio::spawn(serve_io_with_services(
        reader,
        writer,
        |_, _, services| async move {
            let handle = services.service::<Value, Value>(ServiceRef {
                id: "demo.slow".into(),
                version: "1.0".into(),
            });
            let _ = tokio::time::timeout(Duration::from_millis(20), handle.call(&json!({}))).await;
            Execution::complete(Ok(json!({"cancelled":true}).into()))
        },
    ));
    let (reader, mut writer) = tokio::io::split(host);
    let mut reader = BufReader::new(reader);
    start(&mut reader, &mut writer, 5_000_000_000).await;
    let call = receive(&mut reader).await;
    let cancel = receive(&mut reader).await;
    assert_eq!(cancel["command"], "service_cancel");
    assert_eq!(cancel["call_id"], call["call_id"]);
    assert_eq!(receive(&mut reader).await["command"], "finished");
    plugin.await.unwrap().unwrap();
}
