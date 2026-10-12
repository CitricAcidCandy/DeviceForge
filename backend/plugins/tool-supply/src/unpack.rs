//! 逐成员受控解压；拒绝越界、链接、重复路径及跨平台危险名称。
use crate::{
    budget::Budget,
    error::{Error, Result},
};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub(crate) fn relative(value: &str, allow_empty: bool) -> Result<PathBuf> {
    if allow_empty && value.is_empty() {
        return Ok(PathBuf::new());
    }
    if value.is_empty() || value.len() > 512 || value.contains('\\') || value.starts_with('/') {
        return Err(Error::Invalid("归档路径必须是有界相对路径"));
    }
    let mut path = PathBuf::new();
    for part in value.trim_end_matches('/').split('/') {
        let device = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || part
                .chars()
                .any(|character| character.is_control() || "<>:\"|?*".contains(character))
            || matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && matches!(device.as_bytes()[3], b'1'..=b'9'))
            || part.eq_ignore_ascii_case(crate::storage::STATE_FILE)
        {
            return Err(Error::Invalid("归档成员路径不安全或占用插件状态文件"));
        }
        path.push(part);
    }
    Ok(path)
}
fn preflight(file: &mut fs::File, file_limit: usize, budget: &Budget) -> Result<()> {
    budget.check()?;
    let length = file
        .metadata()
        .map_err(|_| Error::Io("读取 ZIP 长度失败"))?
        .len();
    let tail_length = length.min(65557) as usize;
    let mut tail = vec![0u8; tail_length];
    file.seek(SeekFrom::End(-(tail_length as i64)))
        .map_err(|_| Error::Io("定位 ZIP 目录失败"))?;
    file.read_exact(&mut tail)
        .map_err(|_| Error::Io("读取 ZIP 目录失败"))?;
    let position = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&index| {
            tail[index..].starts_with(b"PK\x05\x06")
                && index + 22 + u16::from_le_bytes([tail[index + 20], tail[index + 21]]) as usize
                    == tail.len()
        })
        .ok_or(Error::Invalid("ZIP 缺少有界末尾目录"))?;
    let short = |offset| u16::from_le_bytes([tail[position + offset], tail[position + offset + 1]]);
    let long = |offset| {
        u32::from_le_bytes([
            tail[position + offset],
            tail[position + offset + 1],
            tail[position + offset + 2],
            tail[position + offset + 3],
        ])
    };
    let count = short(10) as usize;
    let directory_size = long(12) as u64;
    let directory_offset = long(16) as u64;
    // 先限制元数据再交 ZIP 库分配成员表；本插件不接受分卷或 ZIP64。
    if short(4) != 0
        || short(6) != 0
        || short(8) as usize != count
        || count == u16::MAX as usize
        || directory_size == u32::MAX as u64
        || directory_offset == u32::MAX as u64
    {
        return Err(Error::Invalid("不支持分卷或 ZIP64 归档"));
    }
    if count == 0 || count > file_limit || directory_size > count as u64 * 4096 {
        return Err(Error::TooLarge);
    }
    if directory_offset
        .checked_add(directory_size)
        .is_none_or(|end| end > length)
    {
        return Err(Error::Invalid("ZIP 目录越界"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| Error::Io("重置 ZIP 读取位置失败"))?;
    budget.check()
}
pub(crate) fn extract(
    archive: &Path,
    output: &Path,
    limit: u64,
    file_limit: usize,
    budget: &Budget,
) -> Result<()> {
    budget.check()?;
    let mut file = fs::File::open(archive).map_err(|_| Error::Io("打开下载归档失败"))?;
    preflight(&mut file, file_limit, budget)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| Error::Invalid("下载文件不是合法 ZIP"))?;
    if archive.is_empty() || archive.len() > file_limit {
        return Err(Error::TooLarge);
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    fs::create_dir(output).map_err(|_| Error::Io("创建解压暂存目录失败"))?;
    for index in 0..archive.len() {
        budget.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| Error::Invalid("读取 ZIP 成员失败"))?;
        let relative = relative(entry.name(), false)?;
        if !names.insert(relative.to_string_lossy().to_lowercase()) {
            return Err(Error::Invalid("归档存在重复或大小写冲突成员"));
        }
        let mode = entry.unix_mode().unwrap_or(0);
        if !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) {
            return Err(Error::Invalid("归档禁止符号链接和特殊文件"));
        }
        let target = output.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(target).map_err(|_| Error::Io("创建归档子目录失败"))?;
            continue;
        }
        if entry.size() > limit.saturating_sub(total) {
            return Err(Error::TooLarge);
        }
        fs::create_dir_all(target.parent().ok_or(Error::Invalid("归档成员缺少目录"))?)
            .map_err(|_| Error::Io("创建归档父目录失败"))?;
        let mut writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| Error::Invalid("归档成员重复或结构冲突"))?;
        let mut buffer = [0u8; 32 * 1024];
        let mut written = 0u64;
        loop {
            budget.check()?;
            let count = entry
                .read(&mut buffer)
                .map_err(|_| Error::Invalid("归档成员内容或 CRC 无效"))?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .filter(|value| *value <= limit)
                .ok_or(Error::TooLarge)?;
            written += count as u64;
            writer
                .write_all(&buffer[..count])
                .map_err(|_| Error::Io("写入解压成员失败"))?;
        }
        if written != entry.size() {
            return Err(Error::Invalid("归档成员实际长度不匹配"));
        }
        writer
            .sync_all()
            .map_err(|_| Error::Io("持久化解压成员失败"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &target,
                fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o755 } else { 0o644 }),
            )
            .map_err(|_| Error::Io("设置工具执行权限失败"))?;
        }
    }
    budget.check()
}
