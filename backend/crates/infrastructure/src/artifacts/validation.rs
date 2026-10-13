use apk_domain::artifacts::{ArchiveEntry, ArchivePage};
use apk_domain::{Error, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use zip::ZipArchive;

const MAX_ENTRIES: usize = 10_000;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
const HASH_BUFFER_SIZE: usize = 64 * 1024;
pub(crate) const DEX_LIMIT: u64 = 64 * 1024 * 1024;

pub(crate) fn content_digest(path: &Path) -> Result<(u64, String)> {
    let mut file = File::open(path).map_err(|error| Error::Storage(error.to_string()))?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0; HASH_BUFFER_SIZE];
    loop {
        let length = file
            .read(&mut buffer)
            .map_err(|error| Error::Storage(error.to_string()))?;
        if length == 0 {
            break;
        }
        size = size
            .checked_add(length as u64)
            .ok_or_else(|| Error::Invalid("产物大小溢出".into()))?;
        digest.update(&buffer[..length]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
}
pub(crate) fn archive(path: &Path) -> Result<ZipArchive<File>> {
    let mut file = File::open(path).map_err(|e| Error::Storage(e.to_string()))?;
    let declared = preflight(&mut file)?;
    let archive =
        ZipArchive::new(file).map_err(|_| Error::Invalid("文件不是有效的 ZIP 容器".into()))?;
    if archive.len() != declared {
        return Err(Error::Invalid("ZIP 包含重复条目或目录数量不匹配".into()));
    }
    Ok(archive)
}
fn preflight(file: &mut File) -> Result<usize> {
    // 先检查固定大小的尾部，避免库解析恶意条目数量时大量分配内存。
    let size = file
        .metadata()
        .map_err(|e| Error::Storage(e.to_string()))?
        .len();
    let length = size.min(65_557) as usize;
    if length < 22 {
        return Err(Error::Invalid("ZIP 尾部不完整".into()));
    }
    file.seek(SeekFrom::End(-(length as i64)))
        .map_err(|e| Error::Storage(e.to_string()))?;
    let mut tail = vec![0; length];
    file.read_exact(&mut tail)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let offset = (0..=length - 22)
        .rev()
        .find(|&offset| {
            tail[offset..offset + 4] == *b"PK\x05\x06"
                && offset + 22 + u16::from_le_bytes([tail[offset + 20], tail[offset + 21]]) as usize
                    == length
        })
        .ok_or_else(|| Error::Invalid("ZIP 目录尾部无效".into()))?;
    let footer = &tail[offset..];
    let count = u16::from_le_bytes([footer[10], footer[11]]) as usize;
    if count > MAX_ENTRIES {
        return Err(Error::Invalid("压缩包条目超过 10000".into()));
    }
    if footer[4..8] != [0, 0, 0, 0]
        || footer[8..10] != footer[10..12]
        || (offset >= 20 && &tail[offset - 20..offset - 16] == b"PK\x06\x07")
    {
        return Err(Error::Invalid("当前不支持分卷或 ZIP64 产物".into()));
    }
    let directory_size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) as u64;
    let directory_offset = u32::from_le_bytes(footer[16..20].try_into().unwrap()) as u64;
    let footer_offset = size - length as u64 + offset as u64;
    if directory_offset + directory_size > footer_offset || directory_size < count as u64 * 46 {
        return Err(Error::Invalid("ZIP 目录范围与条目数量不匹配".into()));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(count)
}
pub(crate) fn safe_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.chars().any(char::is_control)
        && !name.split('/').any(|part| part == ".." || part == ".")
}
pub fn validate_archive(path: &Path) -> Result<()> {
    let mut archive = archive(path)?;
    if archive.len() > MAX_ENTRIES {
        return Err(Error::Invalid("压缩包条目超过 10000".into()));
    }
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| Error::Invalid("压缩条目无效或已加密".into()))?;
        if !safe_entry(entry.name())
            || entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::Invalid("压缩条目包含越界路径或符号链接".into()));
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| Error::Invalid("压缩包体积溢出".into()))?;
        if expanded > MAX_EXPANDED {
            return Err(Error::Invalid("压缩包声明解压体积超过 2 GiB".into()));
        }
    }
    Ok(())
}
pub fn entries(path: &Path, offset: usize, limit: usize) -> Result<ArchivePage> {
    let mut archive = archive(path)?;
    let total = archive.len();
    if offset > total {
        return Err(Error::Invalid("压缩条目游标越界".into()));
    }
    let end = offset.saturating_add(limit).min(total);
    let mut entries = Vec::with_capacity(end - offset);
    for index in offset..end {
        let entry = archive
            .by_index(index)
            .map_err(|_| Error::Invalid("压缩条目无效".into()))?;
        entries.push(ArchiveEntry {
            name: entry.name().into(),
            size: entry.size(),
            compressed_size: entry.compressed_size(),
            directory: entry.is_dir(),
        });
    }
    Ok(ArchivePage {
        entries,
        total,
        next_offset: (end < total).then_some(end),
    })
}
pub fn validate_png(path: &Path) -> Result<()> {
    let mut file = File::open(path).map_err(|e| Error::Storage(e.to_string()))?;
    let size = file
        .seek(SeekFrom::End(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| Error::Storage(e.to_string()))?;
    let mut header = [0; 24];
    file.read_exact(&mut header)
        .map_err(|_| Error::Invalid("PNG 头部不完整".into()))?;
    if size < 45
        || &header[..8] != b"\x89PNG\r\n\x1a\n"
        || &header[8..16] != b"\0\0\0\rIHDR"
        || u32::from_be_bytes(header[16..20].try_into().unwrap()) == 0
        || u32::from_be_bytes(header[20..24].try_into().unwrap()) == 0
    {
        return Err(Error::Invalid("PNG 标识或尺寸无效".into()));
    }
    Ok(())
}

/// 按文件类型执行同一内容门禁，上传和插件输出共同使用。
pub fn validate_content(path: &Path, media_type: &str) -> apk_domain::Result<()> {
    use apk_domain::Error;
    if super::spreadsheet::is_supported(media_type) {
        return super::spreadsheet::validate(path, media_type);
    }
    if super::stream_content::limit(media_type).is_some() {
        return super::stream_content::validate(path, media_type);
    }
    if media_type == "image/png" {
        return validate_png(path);
    }
    if media_type == "image/jpeg" {
        return validate_jpeg(path);
    }
    if media_type == "application/zip" {
        return validate_archive(path);
    }
    if media_type == "application/vnd.android.dex" {
        return validate_dex(path);
    }
    if !matches!(media_type, "application/json" | "application/msgpack") {
        return Err(Error::Invalid("未知产物媒体类型".into()));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| Error::Storage(e.to_string()))?
        .take(deviceforge_data_codec::MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::Storage(e.to_string()))?;
    let result = if media_type == "application/json" {
        deviceforge_data_codec::parse_json(&bytes).map(|_| ())
    } else {
        deviceforge_data_codec::validate_msgpack(&bytes)
    };
    result.map_err(|error| match error {
        deviceforge_data_codec::Error::Limit => Error::TooLarge,
        _ => Error::Invalid(error.to_string()),
    })
}

fn validate_jpeg(path: &Path) -> Result<()> {
    let mut file = File::open(path).map_err(|error| Error::Storage(error.to_string()))?;
    let mut validator = deviceforge_data_codec::jpeg::Validator::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file
            .read(&mut buffer)
            .map_err(|error| Error::Storage(error.to_string()))?;
        if length == 0 {
            break;
        }
        validator.push(&buffer[..length]).map_err(jpeg_error)?;
    }
    validator.finish().map(|_| ()).map_err(jpeg_error)
}

fn jpeg_error(error: deviceforge_data_codec::jpeg::Error) -> Error {
    match error {
        deviceforge_data_codec::jpeg::Error::Limit => Error::TooLarge,
        _ => Error::Invalid(error.to_string()),
    }
}

fn validate_dex(path: &Path) -> Result<()> {
    let mut file = File::open(path).map_err(|error| Error::Storage(error.to_string()))?;
    let size = file
        .metadata()
        .map_err(|error| Error::Storage(error.to_string()))?
        .len();
    if size > DEX_LIMIT {
        return Err(Error::TooLarge);
    }
    let mut header = [0; 44];
    if size < 112 {
        return Err(Error::Invalid("DEX 头部不完整".into()));
    }
    file.read_exact(&mut header)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::UnexpectedEof => Error::Invalid("DEX 头部不完整".into()),
            _ => Error::Storage(error.to_string()),
        })?;
    if !matches!(
        &header[..8],
        b"dex\n035\0" | b"dex\n037\0" | b"dex\n038\0" | b"dex\n039\0" | b"dex\n040\0"
    ) || u64::from(u32::from_le_bytes(header[32..36].try_into().unwrap())) != size
        || u32::from_le_bytes(header[36..40].try_into().unwrap()) != 112
        || u32::from_le_bytes(header[40..44].try_into().unwrap()) != 0x1234_5678
    {
        return Err(Error::Invalid("DEX 标识、长度、头部或字节序无效".into()));
    }
    Ok(())
}
