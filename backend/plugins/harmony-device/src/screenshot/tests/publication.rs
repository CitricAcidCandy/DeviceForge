use super::super::publish;
use super::{JPEG, with_control};
use crate::{
    Control, Error,
    control::{AuthorizedOutput, RemotePhase},
};
use apk_plugin_sdk::{ArtifactOutput, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::Output;
use std::{
    future::Future,
    sync::{Arc, atomic::Ordering},
    task::Poll,
    time::Duration,
};

fn output() -> Output {
    Output {
        value: serde_json::Value::Null,
        artifacts: vec![ArtifactOutput {
            filename: "screenshot.jpeg".into(),
        }],
    }
}

fn assert_record(control: &Control, created: bool, closed: bool, handed_off: bool) {
    let authorized = control.lease.output.lock().unwrap();
    let record = authorized.as_ref().unwrap();
    assert_eq!(
        (record.created, record.closed, record.handed_off),
        (created, closed, handed_off)
    );
}

#[tokio::test]
async fn authorized_destination_is_registered_before_waiting_for_the_file_work_slot() {
    with_control(|control| async move {
        let scratch = tempfile::tempdir().unwrap();
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        let permit = control.lease.slots.clone().acquire_owned().await.unwrap();
        let mut preparing = Box::pin(publish::prepare(
            &control,
            scratch.path().into(),
            target.clone(),
        ));
        std::future::poll_fn(|context| {
            assert!(preparing.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(
            control.lease.output.lock().unwrap().as_ref().unwrap().path,
            target
        );
        assert_record(&control, false, false, false);
        assert!(!target.exists());
        drop(permit);
        let (directory, token) = preparing.await.unwrap();
        assert_eq!(token.len(), 32);
        assert_eq!(
            control.lease.remote().unwrap(),
            Some((token, RemotePhase::Idle))
        );
        assert!(directory.is_dir());
        publish::cleanup(&control, true).await.unwrap();
        assert!(!directory.exists());
        assert!(control.lease.output.lock().unwrap().is_none());
        assert_eq!(
            control
                .finish_output(Err(Error::Invalid("测试失败")))
                .cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

#[tokio::test]
async fn create_new_collision_never_takes_ownership_or_deletes_the_existing_file() {
    with_control(|control| async move {
        let scratch = tempfile::tempdir().unwrap();
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        std::fs::write(&target, "已有用户文件".as_bytes()).unwrap();
        let (directory, _) = publish::prepare(&control, scratch.path().into(), target.clone())
            .await
            .unwrap();
        let source = directory.join("screenshot.jpeg");
        std::fs::write(&source, JPEG).unwrap();
        assert!(publish::copy(&control, source).await.is_err());
        assert_record(&control, false, false, false);
        assert!(!control.unresolved.load(Ordering::Acquire));
        publish::cleanup(&control, true).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), "已有用户文件".as_bytes());
        assert!(!directory.exists());
        assert_eq!(
            control
                .finish_output(Err(Error::Invalid("测试碰撞")))
                .cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

#[tokio::test]
async fn cancelled_call_deletes_only_its_created_and_actually_closed_destination() {
    with_control(|control| async move {
        let scratch = tempfile::tempdir().unwrap();
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        let preserved = authorization.path().join("other.jpeg");
        std::fs::write(&preserved, b"preserved").unwrap();
        let (directory, _) = publish::prepare(&control, scratch.path().into(), target.clone())
            .await
            .unwrap();
        let source = directory.join("screenshot.jpeg");
        std::fs::write(&source, JPEG).unwrap();
        publish::copy(&control, source).await.unwrap();
        assert_record(&control, true, true, false);
        assert_eq!(std::fs::read(&target).unwrap(), JPEG);
        control.context.cancellation().cancel();
        publish::cleanup(&control, true).await.unwrap();
        assert!(!target.exists());
        assert!(!directory.exists());
        assert_eq!(std::fs::read(&preserved).unwrap(), b"preserved");
        let execution = control.finish_output(Err(Error::Cancelled));
        assert_eq!(execution.cleanup, CleanupOutcome::Complete);
        assert_eq!(execution.outcome.err().unwrap(), "操作已取消");
    })
    .await;
}

#[tokio::test]
async fn runtime_handoff_keeps_original_bytes_and_prevents_later_failure_cleanup_deletion() {
    with_control(|control| async move {
        let scratch = tempfile::tempdir().unwrap();
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        let (directory, _) = publish::prepare(&control, scratch.path().into(), target.clone())
            .await
            .unwrap();
        let source = directory.join("screenshot.jpeg");
        std::fs::write(&source, JPEG).unwrap();
        publish::copy(&control, source).await.unwrap();
        publish::cleanup(&control, false).await.unwrap();
        assert!(!directory.exists());
        assert_record(&control, true, true, false);
        control.check().unwrap();
        let execution = control.finish_output(Ok(output()));
        assert_eq!(execution.cleanup, CleanupOutcome::Complete);
        let result = execution.outcome.unwrap();
        assert_eq!(result.value, serde_json::Value::Null);
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].filename, "screenshot.jpeg");
        assert_record(&control, true, true, true);
        publish::cleanup(&control, true).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), JPEG);
    })
    .await;
}

#[tokio::test]
async fn missing_owned_file_and_directory_confirm_cleanup_after_actual_close() {
    with_control(|control| async move {
        let scratch = tempfile::tempdir().unwrap();
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        let (directory, _) = publish::prepare(&control, scratch.path().into(), target.clone())
            .await
            .unwrap();
        let source = directory.join("screenshot.jpeg");
        std::fs::write(&source, JPEG).unwrap();
        publish::copy(&control, source).await.unwrap();
        assert_record(&control, true, true, false);
        std::fs::remove_file(&target).unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        publish::cleanup(&control, true).await.unwrap();
        assert!(control.lease.output.lock().unwrap().is_none());
        assert!(control.lease.directory().unwrap().is_none());
        assert_eq!(
            control
                .finish_output(Err(Error::Invalid("测试缺失")))
                .cleanup,
            CleanupOutcome::Complete
        );
    })
    .await;
}

#[tokio::test]
async fn unclosed_owned_output_cannot_be_deleted_or_handed_off_and_failure_stays_sticky() {
    with_control(|control| async move {
        let authorization = tempfile::tempdir().unwrap();
        let target = authorization.path().join("screenshot.jpeg");
        std::fs::write(&target, JPEG).unwrap();
        *control.lease.output.lock().unwrap() = Some(AuthorizedOutput {
            path: target.clone(),
            created: true,
            closed: false,
            handed_off: false,
        });
        assert!(matches!(
            publish::cleanup(&control, true).await,
            Err(Error::CleanupFailed)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), JPEG);
        assert!(control.unresolved.load(Ordering::Acquire));
        assert_eq!(
            control.finish_output(Ok(output())).cleanup,
            CleanupOutcome::Failed
        );
        control
            .lease
            .output
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .closed = true;
        publish::cleanup(&control, true).await.unwrap();
        assert!(!target.exists());
        let execution = control.finish_output(Ok(output()));
        assert_eq!(execution.cleanup, CleanupOutcome::Failed);
        assert_eq!(execution.outcome.err().unwrap(), "插件资源清理未确认");
    })
    .await;
}

struct Release(std::sync::mpsc::Sender<()>);

impl Drop for Release {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[tokio::test]
async fn dropped_file_work_waiter_keeps_lease_until_real_worker_exit_without_renewing_cleanup() {
    with_control(|control| async move {
        let (release, gate) = std::sync::mpsc::channel();
        let release = Release(release);
        let (started, observing) = tokio::sync::oneshot::channel();
        let mut working = Box::pin(control.work(move |_| {
            started.send(()).unwrap();
            gate.recv().unwrap();
            Ok(())
        }));
        tokio::select! {
            result = &mut working => panic!("工作线程应由门闩阻塞：{result:?}"),
            result = observing => result.unwrap(),
        }
        assert_eq!(Arc::strong_count(&control.lease), 2);
        drop(working);
        assert!(control.unresolved.load(Ordering::Acquire));
        let fixed = control.lease.cleanup_point().unwrap();
        assert_eq!(Arc::strong_count(&control.lease), 2);
        assert_eq!(
            control.finish_output(Ok(output())).cleanup,
            CleanupOutcome::Failed
        );
        drop(release);
        tokio::time::timeout(Duration::from_secs(2), async {
            while Arc::strong_count(&control.lease) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(control.lease.cleanup_point().unwrap(), fixed);
        assert!(control.unresolved.load(Ordering::Acquire));
        assert_eq!(
            control.finish_output(Ok(output())).cleanup,
            CleanupOutcome::Failed
        );
    })
    .await;
}
