use super::StreamingInput;
use crate::{Error, OutputStream, Result};
use std::{io, process::ExitStatus};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

/// 原始输出块；两路内部保序，不保证不同管道之间的全局先后顺序。
#[derive(Debug, PartialEq, Eq)]
pub struct StreamChunk {
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
}

/// 非零退出仍返回真实状态；计数包含已经被 recv 或 wait 消费的全部输出。
#[derive(Debug)]
pub struct StreamExit {
    pub status: ExitStatus,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

/// 会话丢弃只撤销输入和业务；后台继续直接进程的确认等待。
pub struct StreamingProcess {
    input: StreamingInput,
    output: mpsc::Receiver<StreamChunk>,
    cancel: CancellationToken,
    handle: Option<JoinHandle<Result<StreamExit>>>,
}

impl StreamingProcess {
    pub(super) fn new(
        input: StreamingInput,
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

    /// 等待时排空并丢弃未读输出；等待 Future 被丢弃后可再次调用。
    pub async fn wait(&mut self) -> Result<StreamExit> {
        let handle = self
            .handle
            .as_mut()
            .ok_or(Error::InvalidOptions("流式进程终态已读取"))?;
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
        // JoinHandle 留在 self 内直到等待真正结束，不提前转移后台所有权。
        self.handle.take();
        while self.output.try_recv().is_ok() {}
        outcome.map_err(|error| Error::CleanupFailed {
            cause: Box::new(Error::ProcessIo(io::Error::other(error))),
        })?
    }
}

impl Drop for StreamingProcess {
    fn drop(&mut self) {
        self.cancel();
        // 不 abort 监督任务；Owner 保留清理确认与租约归属。
    }
}
