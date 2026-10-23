//! 覆盖整帧已写出后恰好取消、刷新失败与刷新持续背压。
use super::*;
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio_util::sync::CancellationToken;

struct CancelAtFlush {
    bytes: Vec<u8>,
    cancel: CancellationToken,
    flushes: Arc<AtomicUsize>,
    pending: bool,
    fail: bool,
}

impl AsyncWrite for CancelAtFlush {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.bytes.extend_from_slice(bytes);
        self.cancel.cancel();
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.flushes.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            Poll::Ready(Err(io::Error::other("测试刷新失败")))
        } else if self.pending {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn fixture(pending: bool, fail: bool) -> (Arc<State>, CancelAtFlush, SessionEvent) {
    let context = InvocationContext::from_start(Instant::now(), 60_000_000_000).unwrap();
    let writer = CancelAtFlush {
        bytes: Vec::new(),
        cancel: context.cancellation(),
        flushes: Arc::new(AtomicUsize::new(0)),
        pending,
        fail,
    };
    let state = State::new(context);
    let event = SessionEvent::output(
        "flush-cancel",
        1,
        apk_plugin_sdk::session::SessionStream::Stdout,
        vec![1, 2, 3],
    );
    (state, writer, event)
}

#[tokio::test(start_paused = true)]
async fn cancellation_after_all_bytes_still_flushes_the_complete_frame() {
    let (state, mut writer, event) = fixture(false, false);
    let result = output(&mut writer, &event, &state, Duration::from_secs(2))
        .await
        .unwrap();
    assert!(matches!(result, Written::Complete(Some(_))));
    assert_eq!(writer.flushes.load(Ordering::SeqCst), 1);
    assert_eq!(writer.bytes.last(), Some(&b'\n'));
    serde_json::from_slice::<SessionEvent>(&writer.bytes).unwrap();
}

#[tokio::test(start_paused = true)]
async fn flush_error_cannot_be_reported_as_completed_frame() {
    let (state, mut writer, event) = fixture(false, true);
    assert!(
        output(&mut writer, &event, &state, Duration::from_secs(2))
            .await
            .is_err()
    );
}

#[tokio::test(start_paused = true)]
async fn pending_flush_expires_without_renewing_the_fixed_grace() {
    let (state, mut writer, event) = fixture(true, false);
    let observed = writer.flushes.clone();
    let running =
        tokio::spawn(
            async move { output(&mut writer, &event, &state, Duration::from_secs(2)).await },
        );
    while observed.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(1999)).await;
    assert!(!running.is_finished());
    tokio::time::advance(Duration::from_millis(2)).await;
    assert!(running.await.unwrap().is_err());
}
