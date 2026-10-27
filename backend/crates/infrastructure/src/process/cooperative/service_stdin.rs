//! 关闭协议输入时释放真实管道句柄，不能只调用可能为空操作的 shutdown。
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::AsyncWrite;

pub(super) struct ClosingStdin<W>(Option<W>);

impl<W> ClosingStdin<W> {
    pub(super) fn new(writer: W) -> Self {
        Self(Some(writer))
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for ClosingStdin<W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.0.as_mut() {
            Some(writer) => Pin::new(writer).poll_write(cx, bytes),
            None => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "服务输入管道已关闭",
            ))),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.0.as_mut() {
            Some(writer) => Pin::new(writer).poll_flush(cx),
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(writer) = self.0.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        let result = match Pin::new(writer).poll_shutdown(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(result) => result,
        };
        // ChildStdin 的 shutdown 不保证关闭 OS 句柄；EOF 必须先于等待插件退出。
        drop(self.0.take());
        Poll::Ready(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::io::AsyncWriteExt;

    struct Writer {
        dropped: Arc<AtomicBool>,
        pending: bool,
        fail: bool,
    }

    impl Drop for Writer {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::Release);
        }
    }

    impl AsyncWrite for Writer {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            if self.pending {
                self.pending = false;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            Poll::Ready(if self.fail {
                Err(io::Error::other("模拟刷新失败"))
            } else {
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn noop_shutdown_still_drops_the_pipe_before_returning() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut writer = ClosingStdin::new(Writer {
            dropped: dropped.clone(),
            pending: false,
            fail: false,
        });
        writer.write_all(b"frame\n").await.unwrap();
        writer.shutdown().await.unwrap();
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(
            writer.write_all(b"late").await.unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        writer.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn pending_shutdown_keeps_the_pipe_until_it_is_ready() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut writer = ClosingStdin::new(Writer {
            dropped: dropped.clone(),
            pending: true,
            fail: false,
        });
        let shutdown = writer.shutdown();
        tokio::pin!(shutdown);
        assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
        assert!(!dropped.load(Ordering::Acquire));
        shutdown.await.unwrap();
        assert!(dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn failed_shutdown_closes_the_pipe_without_hiding_the_error() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut writer = ClosingStdin::new(Writer {
            dropped: dropped.clone(),
            pending: false,
            fail: true,
        });
        assert!(writer.shutdown().await.is_err());
        assert!(dropped.load(Ordering::Acquire));
    }
}
