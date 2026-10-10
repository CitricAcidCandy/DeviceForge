use super::*;
use deviceforge_plugin_runtime::{InvocationContext, serve_io_with_context};
use std::{
    future::{Future, poll_fn},
    sync::mpsc,
    task::Poll,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::oneshot};

async fn context() -> InvocationContext {
    let (mut client, server) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(server);
    let (sender, receiver) = oneshot::channel();
    let running = tokio::spawn(serve_io_with_context(
        reader,
        writer,
        move |_, context| async move {
            sender.send(context).unwrap();
            Execution::complete(Ok(Output::from(serde_json::Value::Null)))
        },
    ));
    client.write_all(b"{\"protocol_version\":4,\"request_id\":\"resources\",\"operation\":\"app.install\",\"input\":{}}\n{\"protocol_version\":4,\"request_id\":\"resources\",\"command\":\"start\",\"remaining_timeout_ns\":60000000000}\n").await.unwrap();
    let context = receiver.await.unwrap();
    running.await.unwrap().unwrap();
    context
}

async fn session() -> Session {
    Session {
        control: Control::new(context().await, "unused-HDC".into()),
    }
}

async fn pending<F: Future>(future: std::pin::Pin<&mut F>) {
    let mut future = future;
    poll_fn(|task| {
        assert!(matches!(future.as_mut().poll(task), Poll::Pending));
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn active_worker_keeps_slot_and_lease_until_real_return() {
    let session = session().await;
    let (started, ready) = oneshot::channel();
    let (release, gate) = mpsc::channel();
    let work = session.work(move |_| {
        started.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(2)).unwrap();
        Ok(())
    });
    tokio::pin!(work);
    pending(work.as_mut()).await;
    tokio::time::timeout(Duration::from_secs(1), ready)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Arc::strong_count(&session.control.lease), 2);
    assert!(
        session
            .control
            .lease
            .slots
            .clone()
            .try_acquire_owned()
            .is_err()
    );
    release.send(()).unwrap();
    work.await.unwrap();
    assert_eq!(Arc::strong_count(&session.control.lease), 1);
    assert!(
        session
            .control
            .lease
            .slots
            .clone()
            .try_acquire_owned()
            .is_ok()
    );
    assert!(!session.control.unresolved.load(Ordering::Acquire));
}

#[tokio::test]
async fn dropped_future_keeps_private_directory_and_sticky_failure() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let (started, ready) = oneshot::channel();
    let (release, gate) = mpsc::channel();
    let mut work = Box::pin(session.work(move |_| {
        started.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(2)).unwrap();
        Ok(())
    }));
    pending(work.as_mut()).await;
    tokio::time::timeout(Duration::from_secs(1), ready)
        .await
        .unwrap()
        .unwrap();
    drop(work);
    assert!(session.control.unresolved.load(Ordering::Acquire));
    let first = session.control.lease.cleanup_point().unwrap();
    assert!(directory.exists());
    release.send(()).unwrap();
    let permit = tokio::time::timeout(
        Duration::from_secs(1),
        session.control.lease.slots.clone().acquire_owned(),
    )
    .await
    .unwrap()
    .unwrap();
    drop(permit);
    assert_eq!(session.control.lease.cleanup_point().unwrap(), first);
    let execution = session
        .finish(Ok(Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
}

#[tokio::test]
async fn worker_panic_keeps_private_directory_and_reports_unconfirmed() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let result = session.work::<()>(|_| panic!("预期工作线程异常")).await;
    assert!(matches!(result, Err(Error::CleanupFailed)));
    assert!(session.control.unresolved.load(Ordering::Acquire));
    let execution = session
        .finish(result.map(|_| Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
}

#[tokio::test]
async fn cleanup_failure_result_wins_over_concurrent_cancel() {
    let session = session().await;
    let cancel = session.control.context.cancellation();
    let result = session
        .work::<()>(move |_| {
            cancel.cancel();
            Err(Error::CleanupFailed)
        })
        .await;
    assert!(matches!(result, Err(Error::CleanupFailed)));
    assert!(session.control.unresolved.load(Ordering::Acquire));
}

#[tokio::test]
async fn active_lease_blocks_directory_cleanup() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let active = session.control.lease.clone();
    let execution = session
        .finish(Ok(Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert_eq!(active.directory().unwrap(), Some(directory.clone()));
    assert!(directory.exists());
}

#[tokio::test]
async fn expired_cleanup_point_is_never_renewed_or_allowed_to_delete() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let first = session.control.lease.cleanup_point().unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
    tokio::time::resume();
    assert_eq!(session.control.lease.cleanup_point().unwrap(), first);
    let execution = session
        .finish(Ok(Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
}

#[cfg(windows)]
#[tokio::test]
async fn locked_private_file_prevents_cleanup_confirmation() {
    use std::os::windows::fs::OpenOptionsExt;
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let path = directory.join("input.hap");
    std::fs::write(&path, b"private input").unwrap();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let execution = session
        .finish(Ok(Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
    drop(held);
}
