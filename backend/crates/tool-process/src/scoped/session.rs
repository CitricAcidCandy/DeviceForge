use super::ScopedStreamExit;
use crate::{Error, Result, StreamChunk, StreamingInput};
use std::io;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub struct ScopedStreamingProcess {
    input: StreamingInput,
    output: mpsc::Receiver<StreamChunk>,
    cancel: CancellationToken,
    handle: Option<JoinHandle<Result<ScopedStreamExit>>>,
}

impl ScopedStreamingProcess {
    #[cfg(windows)]
    pub(super) fn new(
        input: StreamingInput,
        output: mpsc::Receiver<StreamChunk>,
        cancel: CancellationToken,
        handle: JoinHandle<Result<ScopedStreamExit>>,
    ) -> Self {
        Self {
            input,
            output,
            cancel,
            handle: Some(handle),
        }
    }

    pub fn input(&self) -> StreamingInput {
        self.input.clone()
    }

    pub async fn recv(&mut self) -> Option<StreamChunk> {
        self.output.recv().await
    }

    pub fn cancel(&self) {
        self.input.revoke();
        self.cancel.cancel();
    }

    pub async fn wait(&mut self) -> Result<ScopedStreamExit> {
        let handle = self
            .handle
            .as_mut()
            .ok_or(Error::InvalidOptions("完整范围进程终态已读取"))?;
        let mut output_closed = false;
        let outcome = loop {
            tokio::select! {
                biased;
                chunk = self.output.recv(), if !output_closed => {
                    output_closed = chunk.is_none();
                }
                outcome = &mut *handle => break outcome,
            }
        };
        self.handle.take();
        while self.output.try_recv().is_ok() {}
        outcome.map_err(|error| Error::CleanupFailed {
            cause: Box::new(Error::ProcessIo(io::Error::other(error))),
        })?
    }
}

impl Drop for ScopedStreamingProcess {
    fn drop(&mut self) {
        self.cancel();
    }
}
