//! 媒体包有界解析与完整帧串行封装；不做解码或播放。
use super::checked;
use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::{InvocationContext, session::SessionOutput};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{io::AsyncReadExt, net::TcpStream, sync::Mutex};

pub(crate) const PAYLOAD_LIMIT: usize = 4 * 1024 * 1024;
#[derive(Clone)]
pub(crate) struct Wire {
    output: SessionOutput,
    lock: Arc<Mutex<()>>,
    epoch: u32,
}
impl Wire {
    pub(crate) fn new(output: SessionOutput, epoch: u32) -> Self {
        Self {
            output,
            lock: Arc::new(Mutex::new(())),
            epoch,
        }
    }
    pub(crate) async fn send(
        &self,
        kind: u8,
        flags: u16,
        pts: u64,
        payload: &[u8],
    ) -> Result<(), String> {
        let header = header(kind, flags, pts, payload.len(), self.epoch)?;
        let _serial = self.lock.lock().await;
        self.output
            .send(SessionStream::Stdout, &header)
            .await
            .map_err(|_| "直播输出已关闭")?;
        for chunk in payload.chunks(8192) {
            self.output
                .send(SessionStream::Stdout, chunk)
                .await
                .map_err(|_| "直播输出已关闭")?;
        }
        Ok(())
    }
    pub(crate) async fn json(&self, kind: u8, payload: Value) -> Result<(), String> {
        self.send(
            kind,
            0,
            0,
            &serde_json::to_vec(&payload).map_err(|_| "直播元数据编码失败")?,
        )
        .await
    }
    pub(crate) async fn status(&self, state: &str, attempt: u32) -> Result<(), String> {
        self.json(5, json!({"state":state,"attempt":attempt})).await
    }
}
fn header(kind: u8, flags: u16, pts: u64, length: usize, epoch: u32) -> Result<[u8; 24], String> {
    if !(1..=6).contains(&kind)
        || (kind == 2 && flags > 2)
        || (kind != 2 && flags != 0)
        || length > PAYLOAD_LIMIT
        || epoch == 0
    {
        return Err("直播帧参数无效或超限".into());
    }
    let mut bytes = [0; 24];
    bytes[..4].copy_from_slice(b"DFML");
    bytes[4] = 1;
    bytes[5] = kind;
    bytes[6..8].copy_from_slice(&flags.to_be_bytes());
    bytes[8..16].copy_from_slice(&pts.to_be_bytes());
    bytes[16..20].copy_from_slice(&(length as u32).to_be_bytes());
    bytes[20..24].copy_from_slice(&epoch.to_be_bytes());
    Ok(bytes)
}
pub(crate) async fn video_header(
    socket: &mut TcpStream,
    context: &InvocationContext,
    wire: &Wire,
) -> Result<(), String> {
    let mut bytes = [0; 12];
    checked(context, async {
        socket
            .read_exact(&mut bytes)
            .await
            .map_err(|_| "无法读取视频配置")?;
        Ok(())
    })
    .await?;
    let width = u32::from_be_bytes(bytes[4..8].try_into().map_err(|_| "视频宽度无效")?);
    let height = u32::from_be_bytes(bytes[8..12].try_into().map_err(|_| "视频高度无效")?);
    if bytes[..4] != [b'h', b'2', b'6', b'4'] {
        return Err("直播仅接受H264视频".into());
    }
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("视频尺寸无效".into());
    }
    wire.json(
        1,
        json!({"codec":"h264","format":"annexb","width":width,"height":height}),
    )
    .await
}
pub(crate) async fn audio_header(
    socket: &mut TcpStream,
    context: &InvocationContext,
    wire: &Wire,
    attempt: u32,
) -> Result<bool, String> {
    let mut bytes = [0; 4];
    checked(context, async {
        socket
            .read_exact(&mut bytes)
            .await
            .map_err(|_| "无法读取音频配置")?;
        Ok(())
    })
    .await?;
    if bytes == [0; 4] {
        wire.status("audio_unavailable", attempt).await?;
        return Ok(false);
    }
    if bytes != [0, b'r', b'a', b'w'] {
        return Err("直播仅接受原始PCM音频".into());
    }
    wire.json(
        3,
        json!({"codec":"pcm_s16le","sample_rate":48000,"channels":2}),
    )
    .await?;
    Ok(true)
}
pub(crate) async fn packet(
    socket: &mut TcpStream,
    context: &InvocationContext,
    audio: bool,
) -> Result<(u16, u64, Vec<u8>), String> {
    let mut bytes = [0; 12];
    checked(context, async {
        socket
            .read_exact(&mut bytes)
            .await
            .map_err(|_| "媒体连接已断开")?;
        Ok(())
    })
    .await?;
    let (flags, pts, length) = packet_header(&bytes, audio)?;
    let mut payload = vec![0; length];
    checked(context, async {
        socket
            .read_exact(&mut payload)
            .await
            .map_err(|_| "媒体载荷已截断")?;
        Ok(())
    })
    .await?;
    Ok((flags, pts, payload))
}
fn packet_header(bytes: &[u8; 12], audio: bool) -> Result<(u16, u64, usize), String> {
    let packed = u64::from_be_bytes(bytes[..8].try_into().map_err(|_| "媒体时间戳无效")?);
    let length = u32::from_be_bytes(bytes[8..12].try_into().map_err(|_| "媒体长度无效")?) as usize;
    if length == 0 || length > PAYLOAD_LIMIT || (audio && !length.is_multiple_of(4)) {
        return Err("媒体载荷无效或超限".into());
    }
    let flags = u16::from(packed & (1 << 62) != 0) | (u16::from(packed & (1 << 63) != 0) << 1);
    if flags == 3 || (audio && flags != 0) {
        return Err("媒体标志无效".into());
    }
    let pts = packed & ((1 << 62) - 1);
    if pts > 9_007_199_254_740_991 {
        return Err("媒体时间戳超过公开数值精度".into());
    }
    Ok((flags, pts, length))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_header_and_bounds() {
        let bytes = header(2, 1, 123, 5, 2).unwrap();
        assert_eq!(&bytes[..8], b"DFML\x01\x02\0\x01");
        assert_eq!(u64::from_be_bytes(bytes[8..16].try_into().unwrap()), 123);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 2);
        assert!(header(2, 0, 0, PAYLOAD_LIMIT + 1, 1).is_err());
        assert!(header(0, 0, 0, 0, 1).is_err());
        assert!(header(2, 3, 0, 0, 1).is_err());
        assert!(header(5, 1, 0, 0, 1).is_err());
        assert!(header(6, 0, 0, 0, 1).is_ok());
    }
    #[test]
    fn codec_flags_lengths_and_public_timestamp_precision() {
        let mut bytes = [0; 12];
        bytes[..8].copy_from_slice(&((1_u64 << 62) | 123).to_be_bytes());
        bytes[8..].copy_from_slice(&4_u32.to_be_bytes());
        assert_eq!(packet_header(&bytes, false).unwrap(), (1, 123, 4));
        assert!(packet_header(&bytes, true).is_err());
        bytes[..8].copy_from_slice(&123_u64.to_be_bytes());
        assert_eq!(packet_header(&bytes, true).unwrap(), (0, 123, 4));
        bytes[8..].copy_from_slice(&3_u32.to_be_bytes());
        assert!(packet_header(&bytes, true).is_err());
        bytes[8..].copy_from_slice(&4_u32.to_be_bytes());
        bytes[..8].copy_from_slice(&9_007_199_254_740_992_u64.to_be_bytes());
        assert!(packet_header(&bytes, false).is_err());
    }
}
