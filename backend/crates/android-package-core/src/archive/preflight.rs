use crate::{Control, Error, IoStage, LimitKind, Result, profiles::MAX_ARCHIVE_ENTRIES};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

pub(super) struct Footer {
    pub count: usize,
    pub directory_offset: u64,
    pub directory_size: u64,
    pub file_size: u64,
}

pub(super) fn read_exact(file: &mut File, bytes: &mut [u8], control: &Control<'_>) -> Result<()> {
    control.check()?;
    file.read_exact(bytes).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            Error::InvalidArchive("容器数据不完整")
        } else {
            Error::io(IoStage::Read, error)
        }
    })?;
    control.check()
}

pub(super) fn seek(file: &mut File, position: u64, control: &Control<'_>) -> Result<()> {
    control.check()?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| Error::io(IoStage::Seek, e))?;
    control.check()
}

pub(super) fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

pub(super) fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("固定头部范围已验证"),
    )
}

pub(super) fn inspect(file: &mut File, control: &Control<'_>) -> Result<Footer> {
    control.check()?;
    let metadata = file
        .metadata()
        .map_err(|e| Error::io(IoStage::Metadata, e))?;
    if !metadata.is_file() {
        return Err(Error::InvalidArgument("输入必须为普通文件"));
    }
    let size = metadata.len();
    let length = size.min(65_557) as usize;
    if length < 22 {
        return Err(Error::InvalidArchive("ZIP 尾部不完整"));
    }
    seek(file, size - length as u64, control)?;
    let mut tail = vec![0; length];
    read_exact(file, &mut tail, control)?;
    let offset = (0..=length - 22)
        .rev()
        .find(|&offset| {
            tail[offset..offset + 4] == *b"PK\x05\x06"
                && offset + 22 + usize::from(u16_at(&tail, offset + 20)) == length
        })
        .ok_or(Error::InvalidArchive("ZIP 目录尾部无效"))?;
    let footer = &tail[offset..];
    let count = usize::from(u16_at(footer, 10));
    if footer[4..8] != [0, 0, 0, 0]
        || footer[8..10] != footer[10..12]
        || count == 0xffff
        || u32_at(footer, 12) == u32::MAX
        || u32_at(footer, 16) == u32::MAX
        || (offset >= 20 && &tail[offset - 20..offset - 16] == b"PK\x06\x07")
    {
        return Err(Error::InvalidArchive("不支持分卷或 ZIP64"));
    }
    if count > MAX_ARCHIVE_ENTRIES {
        return Err(Error::limit(LimitKind::Entries, MAX_ARCHIVE_ENTRIES as u64));
    }
    let directory_size = u64::from(u32_at(footer, 12));
    let directory_offset = u64::from(u32_at(footer, 16));
    let footer_offset = size - length as u64 + offset as u64;
    if directory_offset.checked_add(directory_size) != Some(footer_offset)
        || directory_size < count as u64 * 46
    {
        return Err(Error::InvalidArchive("ZIP 目录范围与条目数量不匹配"));
    }
    control.check()?;
    Ok(Footer {
        count,
        directory_offset,
        directory_size,
        file_size: size,
    })
}

pub(super) fn check_extra(bytes: &[u8]) -> Result<()> {
    let mut position = 0;
    while position < bytes.len() {
        if bytes.len() - position < 4 {
            return Err(Error::InvalidArchive("扩展字段不完整"));
        }
        let tag = u16_at(bytes, position);
        let length = usize::from(u16_at(bytes, position + 2));
        position += 4;
        if tag == 1 {
            return Err(Error::InvalidArchive("不支持 ZIP64 扩展"));
        }
        if length > bytes.len() - position {
            return Err(Error::InvalidArchive("扩展字段越界"));
        }
        position += length;
    }
    Ok(())
}
