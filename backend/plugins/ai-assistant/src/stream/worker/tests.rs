use super::*;
use std::sync::mpsc;
use tokio::sync::oneshot;

async fn context() -> InvocationContext {
    use tokio::io::AsyncWriteExt;

    let (mut host, plugin) = tokio::io::duplex(65536);
    let (reader, writer) = tokio::io::split(plugin);
    let (sender, receiver) = oneshot::channel();
    let runtime = tokio::spawn(deviceforge_plugin_runtime::serve_io_with_context(
        reader,
        writer,
        |_, context| async move {
            sender.send(context).unwrap();
            deviceforge_plugin_runtime::Execution::complete(Ok(serde_json::Value::Null.into()))
        },
    ));
    for frame in [
        serde_json::json!({"protocol_version":4,"request_id":"worker","operation":"test","input":{}}),
        serde_json::json!({"protocol_version":4,"request_id":"worker","command":"start","remaining_timeout_ns":10000000000u64}),
    ] {
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        host.write_all(&bytes).await.unwrap();
    }
    let context = receiver.await.unwrap();
    runtime.await.unwrap().unwrap();
    context.check().unwrap();
    context
}

#[tokio::test]
async fn dropped_worker_keeps_slot_until_physical_return_and_marks_cleanup_unknown() {
    let resources = Arc::new(Resources::default());
    let (release, wait) = mpsc::channel();
    let (started, begun) = oneshot::channel();
    let owned = resources.clone();
    let task = tokio::spawn(async move {
        run(&context().await, &owned, move |_, _| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    begun.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(resources.cleanup_failed());
    let (entered, mut entering) = oneshot::channel();
    let next_resources = Arc::new(Resources::default());
    let next = tokio::spawn(async move {
        run(&context().await, &next_resources, move |_, _| {
            entered.send(()).unwrap();
            Ok(())
        })
        .await
    });
    assert!(
        time::timeout(Duration::from_millis(50), &mut entering)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    entering.await.unwrap();
    next.await.unwrap().unwrap();
    assert!(resources.cleanup_failed());
}

#[tokio::test]
async fn cancelled_worker_waits_for_actual_return_before_confirming_cleanup() {
    let resources = Arc::new(Resources::default());
    let context = context().await;
    let cancel = context.cancellation();
    let (release, wait) = mpsc::channel();
    let (started, begun) = oneshot::channel();
    let owned = resources.clone();
    let mut task = tokio::spawn(async move {
        run(&context, &owned, move |_, _| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    begun.await.unwrap();
    cancel.cancel();
    assert!(
        time::timeout(Duration::from_millis(50), &mut task)
            .await
            .is_err()
    );
    assert!(!resources.cleanup_failed());
    release.send(()).unwrap();
    assert!(task.await.unwrap().unwrap_err().contains("已取消"));
    assert!(!resources.cleanup_failed());
}
