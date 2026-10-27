//! 保留跨 select 的半帧缓冲；写入中断后不向半帧追加任何终态。
use apk_plugin_sdk::services::{FRAME_LIMIT, ServiceFrame};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

pub(super) async fn line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
) -> Result<Vec<u8>, String> {
    loop {
        let available = reader.fill_buf().await.map_err(|_| "服务输入流读取失败")?;
        if available.is_empty() {
            return Err("服务输入流已关闭".into());
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > FRAME_LIMIT {
            return Err("服务帧超过 1 MiB".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(std::mem::take(bytes));
        }
    }
}

pub(super) async fn write<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &ServiceFrame,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| "服务帧编码失败")?;
    if bytes.len() >= FRAME_LIMIT {
        return Err("服务帧超过 1 MiB".into());
    }
    bytes.push(b'\n');
    tokio::time::timeout_at(deadline, async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| "服务帧写入到期")?
    .map_err(|_| "服务帧写入失败".into())
}
