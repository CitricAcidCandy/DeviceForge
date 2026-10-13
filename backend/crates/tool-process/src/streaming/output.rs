use super::StreamChunk;
use crate::{Error, OutputStream, Result};
use std::io;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::mpsc,
};

/// 保留管道字节和分路标识；背压由外层同一期限及取消约束。
pub(crate) async fn read(
    mut reader: impl AsyncRead + Unpin,
    sender: mpsc::Sender<StreamChunk>,
    stream: OutputStream,
    chunk_size: usize,
    limit: u64,
) -> Result<u64> {
    let mut buffer = vec![0; chunk_size];
    let mut total = 0u64;
    loop {
        let size = reader.read(&mut buffer).await.map_err(Error::ProcessIo)?;
        if size == 0 {
            return Ok(total);
        }
        total = total
            .checked_add(size as u64)
            .filter(|total| *total <= limit)
            .ok_or(Error::OutputTooLarge { stream, limit })?;
        let permit = sender
            .reserve()
            .await
            .map_err(|_| Error::ProcessIo(io::Error::other("流式输出接收端已关闭")))?;
        permit.send(StreamChunk {
            stream,
            bytes: buffer[..size].to_vec(),
        });
    }
}
