//! 有界首帧分流，保留任务协议4并增加直播会话5。
use serde_json::Value;
use std::{io::Cursor, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader},
    time,
};
async fn first<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| "投屏首帧读取失败")?;
        if available.is_empty() {
            return Err("投屏缺少完整首帧".into());
        }
        let complete = available.iter().position(|byte| *byte == b'\n');
        let count = complete.map_or(available.len(), |index| index + 1);
        if count > (512 * 1024usize).saturating_sub(bytes.len()) {
            return Err("投屏首帧超过512KiB".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete.is_some() {
            return Ok(bytes);
        }
    }
}
pub async fn serve_io<R, W>(reader: R, writer: W) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let origin = time::Instant::now();
    let mut reader = BufReader::new(reader);
    let bytes = time::timeout(Duration::from_secs(5), first(&mut reader))
        .await
        .map_err(|_| "投屏首帧超过五秒")??;
    let frame: Value = serde_json::from_slice(&bytes).map_err(|_| "投屏首帧不是JSON")?;
    let version = frame
        .get("protocol_version")
        .and_then(Value::as_u64)
        .ok_or("投屏首帧缺少协议版本")?;
    drop(frame);
    let reader = Cursor::new(bytes).chain(reader);
    match version {
        4 => {
            deviceforge_plugin_runtime::serve_io_with_context(reader, writer, crate::execute).await
        }
        5 => {
            let options = deviceforge_plugin_runtime::session::SessionOptions {
                continuous_output: true,
                handshake_timeout: Duration::from_secs(5)
                    .checked_sub(origin.elapsed())
                    .filter(|time| !time.is_zero())
                    .ok_or("投屏握手超过五秒")?,
                ..Default::default()
            };
            deviceforge_plugin_runtime::session::serve_session_io(
                reader,
                writer,
                options,
                crate::execute_stream,
            )
            .await
        }
        _ => Err("投屏只接受任务协议4或会话协议5".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_first_line_keeps_following_frames() {
        let bytes = b"{\"protocol_version\":5}\nnext\n";
        let mut reader = BufReader::new(Cursor::new(bytes));
        assert_eq!(
            first(&mut reader).await.unwrap(),
            b"{\"protocol_version\":5}\n"
        );
        let mut remaining = String::new();
        reader.read_to_string(&mut remaining).await.unwrap();
        assert_eq!(remaining, "next\n");
    }
    #[tokio::test]
    async fn truncated_and_oversized_frames_fail() {
        assert!(
            first(&mut BufReader::new(Cursor::new(b"{}")))
                .await
                .is_err()
        );
        assert!(
            first(&mut BufReader::new(Cursor::new(vec![b'a'; 512 * 1024 + 1])))
                .await
                .is_err()
        );
    }
}
