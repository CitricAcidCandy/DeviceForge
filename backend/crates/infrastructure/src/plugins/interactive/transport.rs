//! 有界换行帧；帧读取的部分缓冲保留在对象中，取消读取等待不会丢字节。
use apk_domain::{Error, Result};
use deviceforge_tool_process::{OutputStream, StreamingInput, StreamingProcess};
use serde::Serialize;
use std::time::Duration;
use tokio::time::Instant;

pub(super) const HANDSHAKE: Duration = Duration::from_secs(5);
pub(super) const CLEANUP: Duration = Duration::from_secs(5);
pub(super) const EXIT: Duration = Duration::from_secs(2);

pub(super) struct Reader {
    buffer: Vec<u8>,
    stderr: u64,
}

impl Reader {
    pub fn new() -> Self { Self { buffer: Vec::new(), stderr: 0 } }

    pub async fn next(&mut self, process: &mut StreamingProcess, limit: usize) -> Result<Option<Vec<u8>>> {
        loop {
            if let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
                if index + 1 > limit { return Err(Error::TooLarge); }
                return Ok(Some(self.buffer.drain(..=index).collect()));
            }
            if self.buffer.len() >= limit { return Err(Error::TooLarge); }
            match process.recv().await {
                Some(chunk) if chunk.stream == OutputStream::Stdout => {
                    self.buffer.extend_from_slice(&chunk.bytes);
                }
                Some(chunk) => {
                    self.stderr = self.stderr.checked_add(chunk.bytes.len() as u64)
                        .ok_or(Error::TooLarge)?;
                    if self.stderr > 1024 * 1024 { return Err(Error::TooLarge); }
                    // 诊断管道不进入业务输出、日志或错误文案。
                }
                None if self.buffer.is_empty() => return Ok(None),
                None => return Err(Error::Dependency("会话传输在完整换行帧前关闭".into())),
            }
        }
    }
}

pub(super) fn frame(value: &impl Serialize, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|_| Error::Invalid("会话帧无法序列化".into()))?;
    bytes.push(b'\n');
    if bytes.len() > limit { return Err(Error::TooLarge); }
    Ok(bytes)
}

pub(super) async fn send(input: &StreamingInput, bytes: &[u8], deadline: Instant) -> Result<()> {
    // Open 大帧先拆成公共管道块；同一发送 Future 完成前不穿插其他帧。
    for chunk in bytes.chunks(65536) {
        tokio::time::timeout_at(deadline, input.send(chunk)).await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Dependency("会话帧写入队列已关闭".into()))?;
    }
    Ok(())
}
