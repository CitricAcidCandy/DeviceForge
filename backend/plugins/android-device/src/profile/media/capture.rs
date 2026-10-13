//! H264帧持续接收，保存编码原字节及PTS；不按采样点重新截图。
use super::rules::Packet;
use crate::{Error, Result};
use std::path::PathBuf;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_util::sync::CancellationToken;
pub(super) struct Captured {
    pub path: PathBuf,
    pub packets: Vec<Packet>,
    pub width: u32,
    pub height: u32,
}
pub(super) async fn run(
    mut socket: TcpStream,
    path: PathBuf,
    stop: CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<Captured> {
    let mut header = [0; 12];
    tokio::select! {biased;_=tokio::time::sleep_until(deadline)=>return Err(Error::Timeout),_=stop.cancelled()=>return Err(Error::Cancelled),r=socket.read_exact(&mut header)=>{r.map_err(|_|Error::Dependency("scrcpy视频配置不完整"))?;}}
    let width = u32::from_be_bytes(
        header[4..8]
            .try_into()
            .map_err(|_| Error::Dependency("scrcpy视频宽度无效"))?,
    );
    let height = u32::from_be_bytes(
        header[8..12]
            .try_into()
            .map_err(|_| Error::Dependency("scrcpy视频高度无效"))?,
    );
    if &header[..4] != b"h264" || width == 0 || height == 0 || width > 1280 || height > 1280 {
        return Err(Error::Dependency("scrcpy视频编码或尺寸不支持"));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .await
        .map_err(|_| Error::Io("视频私有文件无法创建"))?;
    let mut packets = Vec::new();
    let mut total = 0usize;
    let mut has_config = false;
    let mut has_key = false;
    let mut last = None;
    loop {
        let mut header = [0; 12];
        tokio::select! {biased;_=tokio::time::sleep_until(deadline)=>return Err(Error::Timeout),_=stop.cancelled()=>break,r=socket.read_exact(&mut header)=>{r.map_err(|_|Error::Dependency("scrcpy视频流在录制中断开"))?;}}
        let packed = u64::from_be_bytes(
            header[..8]
                .try_into()
                .map_err(|_| Error::Dependency("scrcpy视频PTS无效"))?,
        );
        let size = u32::from_be_bytes(
            header[8..]
                .try_into()
                .map_err(|_| Error::Dependency("scrcpy视频包长度无效"))?,
        ) as usize;
        let config = packed & (1 << 63) != 0;
        let key = packed & (1 << 62) != 0;
        let pts_us = packed & ((1 << 62) - 1);
        if size == 0 || size > 4 * 1024 * 1024 || (config && key) {
            return Err(Error::Dependency("scrcpy视频包标志或长度无效"));
        }
        total = total
            .checked_add(size)
            .filter(|n| *n <= 32 * 1024 * 1024)
            .ok_or(Error::TooLarge)?;
        let mut bytes = vec![0; size];
        tokio::select! {biased;_=tokio::time::sleep_until(deadline)=>return Err(Error::Timeout),_=stop.cancelled()=>break,r=socket.read_exact(&mut bytes)=>{r.map_err(|_|Error::Dependency("scrcpy视频载荷不完整"))?;}}
        if config {
            if has_key {
                return Err(Error::Dependency("scrcpy视频配置在录制中改变"));
            }
            has_config = true;
        } else {
            if !has_config {
                return Err(Error::Dependency("scrcpy视频缺少编码配置"));
            }
            if !has_key && !key {
                continue;
            }
            has_key |= key;
            if packets.len() >= 2000 {
                return Err(Error::TooLarge);
            }
            if last.is_some_and(|v| pts_us < v) {
                return Err(Error::Dependency("scrcpy视频PTS回退"));
            }
            last = Some(pts_us);
        }
        // 已完整收到的包必须写完才登记PTS；取消不交付半包或半帧。
        tokio::time::timeout_at(deadline, file.write_all(&bytes))
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Io("视频私有文件写入失败"))?;
        if !config {
            packets.push(Packet {
                index: packets.len() as u32,
                pts_us,
            });
        }
    }
    tokio::time::timeout_at(deadline, file.flush())
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Io("视频私有文件刷新失败"))?;
    drop(file);
    if packets.is_empty() {
        return Err(Error::Dependency("scrcpy未提供可解码视频帧"));
    }
    Ok(Captured {
        path,
        packets,
        width,
        height,
    })
}
