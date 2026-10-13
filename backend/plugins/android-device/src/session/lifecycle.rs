use super::*;
use deviceforge_plugin_runtime::{InvocationContext, serve_io_with_context};
use std::{
    future::{Future, poll_fn},
    sync::mpsc,
    task::Poll,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::oneshot};

pub(crate) async fn context() -> InvocationContext {
    context_with_budget(60_000_000_000).await
}

async fn context_with_budget(budget: u64) -> InvocationContext {
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
    let frames = format!(
        "{{\"protocol_version\":4,\"request_id\":\"resources\",\"operation\":\"screenshot\",\"input\":{{}}}}\n{{\"protocol_version\":4,\"request_id\":\"resources\",\"command\":\"start\",\"remaining_timeout_ns\":{budget}}}\n"
    );
    client.write_all(frames.as_bytes()).await.unwrap();
    let context = receiver.await.unwrap();
    running.await.unwrap().unwrap();
    context
}

async fn session() -> Session {
    Session {
        profile_root: None,
        control: Control::new(context().await, "unused-ADB".into()),
    }
}

pub(crate) async fn poll_pending<F: Future>(future: std::pin::Pin<&mut F>) {
    let mut future = future;
    poll_fn(|task| {
        assert!(matches!(future.as_mut().poll(task), Poll::Pending));
        Poll::Ready(())
    })
    .await;
}

async fn started(receiver: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(1), receiver)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn work_keeps_real_lease_and_single_slot_until_return() {
    let session = session().await;
    let (started_sender, started_receiver) = oneshot::channel();
    let (release, gate) = mpsc::channel();
    let work = session.work(move |_| {
        started_sender.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(2)).unwrap();
        Ok(())
    });
    tokio::pin!(work);
    poll_pending(work.as_mut()).await;
    started(started_receiver).await;
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
async fn dropped_work_keeps_directory_and_marks_unresolved_after_real_return() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let (started_sender, started_receiver) = oneshot::channel();
    let (release, gate) = mpsc::channel();
    let mut work = Box::pin(session.work(move |_| {
        started_sender.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(2)).unwrap();
        Ok(())
    }));
    poll_pending(work.as_mut()).await;
    started(started_receiver).await;
    drop(work);
    assert!(session.control.unresolved.load(Ordering::Acquire));
    assert_eq!(Arc::strong_count(&session.control.lease), 2);
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
    assert!(session.control.unresolved.load(Ordering::Acquire));
    let execution = session
        .finish(Ok(Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
}

#[tokio::test]
async fn work_panic_remains_unresolved_and_does_not_delete_directory() {
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let result = session.work::<()>(|_| panic!("预期worker异常")).await;
    assert!(matches!(result, Err(Error::CleanupFailed)));
    assert!(session.control.unresolved.load(Ordering::Acquire));
    assert_eq!(Arc::strong_count(&session.control.lease), 1);
    let execution = session
        .finish(result.map(|_| Output::from(serde_json::Value::Null)))
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert!(directory.exists());
}

#[tokio::test]
async fn cleanup_failed_worker_result_wins_over_cancel_and_is_sticky() {
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
async fn finish_refuses_active_resource_lease_without_removing_directory() {
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
async fn finish_retains_private_directory_when_fixed_cleanup_point_has_expired() {
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

async fn published() -> (
    Session,
    tempfile::TempDir,
    tempfile::TempDir,
    std::path::PathBuf,
) {
    let session = session().await;
    published_session(session).await
}

async fn published_session(
    session: Session,
) -> (
    Session,
    tempfile::TempDir,
    tempfile::TempDir,
    std::path::PathBuf,
) {
    let scratch = tempfile::tempdir().unwrap();
    session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let authorized = tempfile::tempdir().unwrap();
    let target = authorized.path().join("screenshot.png");
    std::fs::write(&target, "已发布截图".as_bytes()).unwrap();
    *session.control.lease.output.lock().unwrap() = Some(target.clone());
    session.cleanup(false).await.unwrap();
    assert!(session.control.lease.directory().unwrap().is_none());
    assert!(target.exists());
    (session, scratch, authorized, target)
}

#[tokio::test]
async fn cancellation_after_success_cleanup_removes_only_owned_output_at_same_point() {
    let (session, _scratch, authorized, target) = published().await;
    let original = authorized.path().join("other.png");
    std::fs::write(&original, "原有文件".as_bytes()).unwrap();
    let point = session.control.lease.cleanup_point().unwrap();
    session.control.context.cancellation().cancel();
    let execution = session
        .finish_cleaned(Ok(Output::from(serde_json::Value::Null)), false, true)
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Complete);
    assert_eq!(
        execution.outcome.err().unwrap(),
        Error::Cancelled.to_string()
    );
    assert!(!target.exists());
    assert!(original.exists());
    assert!(tokio::time::Instant::now() < point);
}

#[tokio::test]
async fn timeout_after_success_cleanup_cannot_leave_output_with_complete_error() {
    let session = Session {
        profile_root: None,
        control: Control::new(
            context_with_budget(1_000_000_000).await,
            "unused-ADB".into(),
        ),
    };
    let (session, _scratch, _authorized, target) = published_session(session).await;
    let point = session.control.lease.cleanup_point().unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(1100)).await;
    tokio::time::resume();
    assert!(matches!(
        session.control.context.check(),
        Err(deviceforge_plugin_runtime::ContextError::Timeout)
    ));
    assert_eq!(session.control.lease.cleanup_point().unwrap(), point);
    let execution = session
        .finish_cleaned(Ok(Output::from(serde_json::Value::Null)), false, true)
        .await;
    assert_eq!(execution.cleanup, CleanupOutcome::Complete);
    assert_eq!(execution.outcome.err().unwrap(), Error::Timeout.to_string());
    assert!(!target.exists());
}

#[cfg(windows)]
#[tokio::test]
async fn actual_owned_output_delete_failure_retains_directory_and_failed_result() {
    use std::os::windows::fs::OpenOptionsExt;
    let session = session().await;
    let scratch = tempfile::tempdir().unwrap();
    let directory = session
        .create_directory(scratch.path().to_path_buf())
        .await
        .unwrap();
    let authorized = tempfile::tempdir().unwrap();
    let target = authorized.path().join("screenshot.png");
    std::fs::write(&target, b"locked").unwrap();
    *session.control.lease.output.lock().unwrap() = Some(target.clone());
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&target)
        .unwrap();
    let execution = session.finish(Err(Error::Cancelled)).await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert_eq!(
        execution.outcome.err().unwrap(),
        Error::CleanupFailed.to_string()
    );
    assert!(directory.exists());
    assert!(target.exists());
    drop(locked);
}
