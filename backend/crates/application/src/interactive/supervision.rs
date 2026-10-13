use super::entry::Entry;
use crate::registry::Owner;
use apk_domain::{Error, interactive::*};
use futures_util::{FutureExt, future::BoxFuture};
use std::{panic::AssertUnwindSafe, sync::Arc};
use tokio::sync::watch;

pub(super) async fn supervise(
    supervisor: BoxFuture<'static, ()>,
    entry: Arc<Entry>,
    owner: Arc<Owner>,
    done: watch::Sender<bool>,
) {
    if AssertUnwindSafe(supervisor).catch_unwind().await.is_err() {
        owner.mark_unresolved();
        entry.fail(&Error::Dependency("会话监督异常退出".into()));
        entry.cancel();
    }
    done.send_replace(true);
}

pub(super) async fn consume(
    mut handle: Box<dyn InteractiveSession>,
    entry: Arc<Entry>,
    owner: Arc<Owner>,
    mut completed: watch::Receiver<bool>,
) {
    let result = AssertUnwindSafe(pump(handle.as_mut(), &entry))
        .catch_unwind()
        .await;
    let exit = match result {
        Ok(exit) => exit,
        Err(_) => {
            owner.mark_unresolved();
            entry.cancel();
            Arc::new(SessionExit {
                outcome: None,
                cleanup: SessionCleanup::Unconfirmed,
                process_exited: false,
                sequence: None,
                failure: Some(Arc::new(Error::Dependency("会话输出监督异常退出".into()))),
            })
        }
    };
    drop(handle);
    loop {
        if *completed.borrow() {
            break;
        }
        if completed.changed().await.is_err() {
            owner.mark_unresolved();
            entry.fail(&Error::CleanupFailed);
            break;
        }
    }
    entry.finish(&exit, &owner);
    let info = entry.snapshot();
    tracing::info!(session_id = %info.id, plugin_id = %info.plugin_id,
        output_sequence = info.output_sequence,
        cleanup = ?info.completion.as_ref().map(|completion| completion.cleanup),
        "交互会话已结束");
}

async fn pump(handle: &mut dyn InteractiveSession, entry: &Entry) -> Arc<SessionExit> {
    let ready = tokio::select! {
        biased;
        result = handle.ready() => result,
        _ = entry.cancel.cancelled() => Err(Arc::new(Error::Cancelled)),
        _ = tokio::time::sleep_until(entry.deadline) => Err(Arc::new(Error::Timeout)),
    };
    entry.ready.send_replace(Some(ready.clone()));
    if let Err(error) = ready {
        entry.fail(&error);
        entry.cancel();
        return handle.wait().await;
    }
    entry.running();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = entry.cancel.cancelled() => {
                entry.fail(&Error::Cancelled);
                entry.cancel();
                break;
            },
            _ = tokio::time::sleep_until(entry.deadline) => {
                entry.fail(&Error::Timeout);
                entry.cancel();
                break;
            },
            chunk = handle.recv() => chunk,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if let Err(error) = entry.append(chunk) {
            entry.fail(&error);
            entry.cancel();
            break;
        }
    }
    handle.wait().await
}
