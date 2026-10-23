use super::PtyInput;
use crate::{Error, Result, StreamChunk, StreamExit};
use std::io;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub struct PtyProcess {
    input: PtyInput,
    output: mpsc::Receiver<StreamChunk>,
    cancel: CancellationToken,
    handle: Option<JoinHandle<Result<StreamExit>>>,
}

impl PtyProcess {
    #[cfg(windows)]
    pub(super) fn new(
        input: PtyInput,
        output: mpsc::Receiver<StreamChunk>,
        cancel: CancellationToken,
        handle: JoinHandle<Result<StreamExit>>,
    ) -> Self {
        Self {
            input,
            output,
            cancel,
            handle: Some(handle),
        }
    }

    pub fn input(&self) -> PtyInput {
        self.input.clone()
    }

    pub async fn recv(&mut self) -> Option<StreamChunk> {
        self.output.recv().await
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    pub async fn wait(&mut self) -> Result<StreamExit> {
        let handle = self
            .handle
            .as_mut()
            .ok_or(Error::InvalidOptions("终端终态已读取"))?;
        let mut output_closed = false;
        let result = loop {
            tokio::select! {
                biased;
                chunk = self.output.recv(), if !output_closed => output_closed = chunk.is_none(),
                result = &mut *handle => break result,
            }
        };
        self.handle.take();
        result.map_err(|error| Error::CleanupFailed {
            cause: Box::new(Error::ProcessIo(io::Error::other(error))),
        })?
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        self.cancel();
    }
}
