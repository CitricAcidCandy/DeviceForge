use crate::live::{checked, wire::PAYLOAD_LIMIT};
use deviceforge_plugin_runtime::InvocationContext;
use tokio::{io::AsyncReadExt, net::TcpStream};

pub(super) struct Packet {
    pub flags: u8,
    pub pts: u64,
    pub data: Vec<u8>,
}

pub(super) async fn video_header(
    socket: &mut TcpStream,
    context: &InvocationContext,
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
    let width = u32::from_be_bytes(bytes[4..8].try_into().map_err(|_| "视频尺寸无效")?);
    let height = u32::from_be_bytes(bytes[8..12].try_into().map_err(|_| "视频尺寸无效")?);
    if &bytes[..4] != b"h264" || width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("WebRTC 仅接受有界 H264 视频".into());
    }
    Ok(())
}

pub(super) async fn audio_header(
    socket: &mut TcpStream,
    context: &InvocationContext,
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
        return Ok(false);
    }
    if &bytes != b"opus" {
        return Err("WebRTC 仅接受 Opus 音频".into());
    }
    Ok(true)
}

pub(super) async fn packet(
    socket: &mut TcpStream,
    context: &InvocationContext,
) -> Result<Packet, String> {
    let mut header = [0; 12];
    checked(context, async {
        socket
            .read_exact(&mut header)
            .await
            .map_err(|_| "媒体连接已断开")?;
        Ok(())
    })
    .await?;
    let packed = u64::from_be_bytes(header[..8].try_into().map_err(|_| "媒体时间戳无效")?);
    let length = u32::from_be_bytes(header[8..].try_into().map_err(|_| "媒体长度无效")?) as usize;
    if length == 0 || length > PAYLOAD_LIMIT {
        return Err("媒体载荷无效或超限".into());
    }
    let flags = u8::from(packed & (1 << 62) != 0) | (u8::from(packed & (1 << 63) != 0) << 1);
    if flags == 3 {
        return Err("媒体标志无效".into());
    }
    let pts = packed & ((1 << 62) - 1);
    let mut data = vec![0; length];
    checked(context, async {
        socket
            .read_exact(&mut data)
            .await
            .map_err(|_| "媒体载荷已截断")?;
        Ok(())
    })
    .await?;
    Ok(Packet { flags, pts, data })
}

pub(super) fn opus_head(packet: &Packet) -> Result<(), String> {
    let data = &packet.data;
    if packet.flags != 2 || data.len() < 19 || &data[..8] != b"OpusHead" {
        return Err("Opus 配置包无效".into());
    }
    let rate = u32::from_le_bytes(data[12..16].try_into().map_err(|_| "Opus 采样率无效")?);
    if data[8] != 1 || data[9] != 2 || rate != 48_000 || data[18] != 0 {
        return Err("Opus 配置不兼容 48 kHz 双声道".into());
    }
    Ok(())
}

pub(super) fn h264_profile(packet: &Packet) -> Result<String, String> {
    if packet.flags != 2 {
        return Err("H264 缺少起始配置包".into());
    }
    let data = &packet.data;
    for position in 0..data.len() {
        let prefix = if data[position..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if data[position..].starts_with(&[0, 0, 1]) {
            3
        } else {
            continue;
        };
        if position + prefix + 4 <= data.len() && data[position + prefix] & 0x1f == 7 {
            let profile = &data[position + prefix + 1..position + prefix + 4];
            if !matches!(profile[0], 0x42 | 0x4d | 0x64) {
                return Err("H264 profile 不受浏览器合同支持".into());
            }
            return Ok(format!(
                "{:02x}{:02x}{:02x}",
                profile[0], profile[1], profile[2]
            ));
        }
    }
    Err("H264 配置缺少 SPS".into())
}

pub(super) fn sample_duration(
    previous: &mut Option<u64>,
    current: u64,
    default_us: u64,
) -> std::time::Duration {
    let interval = previous.map_or(default_us, |last| current.saturating_sub(last));
    *previous = Some(current);
    std::time::Duration::from_micros(interval.clamp(1, 1_000_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_config_packets() {
        let opus = Packet {
            flags: 2,
            pts: 0,
            data: b"OpusHead\x01\x02\0\0\x80\xbb\0\0\0\0\0".to_vec(),
        };
        assert!(opus_head(&opus).is_ok());
        let video = Packet {
            flags: 2,
            pts: 0,
            data: vec![0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f],
        };
        assert_eq!(h264_profile(&video).unwrap(), "42e01f");
    }
}
