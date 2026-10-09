use crate::{Error, OutputStream, Result};
use std::io;
use tokio::{
    fs::File,
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout},
};

pub(crate) fn take_pipes(child: &mut Child) -> Result<(ChildStdin, ChildStdout, ChildStderr)> {
    let missing = || Error::ProcessIo(io::Error::other("工具缺少已配置的标准管道"));
    Ok((
        child.stdin.take().ok_or_else(missing)?,
        child.stdout.take().ok_or_else(missing)?,
        child.stderr.take().ok_or_else(missing)?,
    ))
}

pub(crate) async fn write_input(mut stdin: ChildStdin, input: Option<&[u8]>) -> Result<()> {
    if let Some(input) = input {
        stdin.write_all(input).await.map_err(Error::ProcessIo)?;
    }
    // 明确关闭输入，使依赖 EOF 的工具能完成；不等待进程读取后的回应。
    drop(stdin);
    Ok(())
}

pub(crate) async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    limit: u64,
    stream: OutputStream,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(Error::ProcessIo)?;
    if bytes.len() as u64 > limit {
        return Err(Error::OutputTooLarge { stream, limit });
    }
    Ok(bytes)
}

pub(crate) async fn copy_to_file(
    mut stdout: ChildStdout,
    file: &mut File,
    limit: u64,
) -> Result<()> {
    let mut buffer = [0; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = stdout.read(&mut buffer).await.map_err(Error::ProcessIo)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .filter(|value| *value <= limit)
            .ok_or(Error::OutputTooLarge {
                stream: OutputStream::Stdout,
                limit,
            })?;
        file.write_all(&buffer[..count])
            .await
            .map_err(Error::FileIo)?;
    }
    file.flush().await.map_err(Error::FileIo)
}
