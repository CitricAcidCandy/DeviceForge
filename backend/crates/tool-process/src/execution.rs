use crate::{
    Error, ExecutionOptions, OutputStream, Result, ToolCommand, command, lifecycle, streams,
};
use std::process::ExitStatus;
use tokio::{fs::File, time};
use tokio_util::sync::CancellationToken;

#[derive(Debug, PartialEq, Eq)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn successful_exit(status: ExitStatus, stderr: Vec<u8>) -> Result<Vec<u8>> {
    if status.success() {
        Ok(stderr)
    } else {
        Err(Error::NonZeroExit {
            code: status.code(),
            stderr,
        })
    }
}

/// 同时发送输入、读取两路输出并等待退出，避免任一管道填满形成死锁。
pub async fn capture(
    command: ToolCommand<'_>,
    options: ExecutionOptions,
    cancel: CancellationToken,
) -> Result<Output> {
    lifecycle::preflight(&options, &cancel)?;
    let mut child = command::prepare(&command).spawn().map_err(Error::Spawn)?;
    let work = async {
        let (stdin, stdout, stderr) = streams::take_pipes(&mut child)?;
        let ((), stdout, stderr, status) = tokio::try_join!(
            streams::write_input(stdin, command.input),
            streams::read_bounded(stdout, options.stdout_limit, OutputStream::Stdout),
            streams::read_bounded(stderr, options.stderr_limit, OutputStream::Stderr),
            async { child.wait().await.map_err(Error::ProcessIo) },
        )?;
        let stderr = successful_exit(status, stderr)?;
        Ok(Output { stdout, stderr })
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        _ = time::sleep_until(options.deadline) => Err(Error::Timeout),
        result = work => result,
    };
    lifecycle::finish(&mut child, result, &options).await
}

/// 标准输出以 64 KiB 缓冲写入调用方文件；失败时保留已写部分，由调用方清理。
pub async fn capture_to_file(
    command: ToolCommand<'_>,
    options: ExecutionOptions,
    cancel: CancellationToken,
    file: &mut File,
    file_limit: u64,
) -> Result<()> {
    lifecycle::preflight(&options, &cancel)?;
    let mut child = command::prepare(&command).spawn().map_err(Error::Spawn)?;
    let work = async {
        let (stdin, stdout, stderr) = streams::take_pipes(&mut child)?;
        let ((), (), stderr, status) = tokio::try_join!(
            streams::write_input(stdin, command.input),
            streams::copy_to_file(stdout, file, file_limit),
            streams::read_bounded(stderr, options.stderr_limit, OutputStream::Stderr),
            async { child.wait().await.map_err(Error::ProcessIo) },
        )?;
        successful_exit(status, stderr)?;
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        _ = time::sleep_until(options.deadline) => Err(Error::Timeout),
        result = work => result,
    };
    lifecycle::finish(&mut child, result, &options).await
}
