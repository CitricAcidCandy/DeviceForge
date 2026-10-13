use apk_domain::{Error, Result};
use std::{fs::File, io::Read, path::Path};

pub(super) const MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
pub(super) const XLS: &str = "application/vnd.ms-excel";
pub(super) const CSV: &str = "text/csv";

pub(super) fn is_supported(media_type: &str) -> bool {
    matches!(media_type, XLSX | XLS | CSV)
}

/// 产物层只核容器最低资格；工作表语义、公式缓存及坐标限额归独立插件。
pub(super) fn validate(path: &Path, media_type: &str) -> Result<()> {
    let mut file = File::open(path).map_err(storage)?;
    let size = file.metadata().map_err(storage)?.len();
    if size > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    if size == 0 {
        return Err(Error::Invalid("电子表格产物不能为空".into()));
    }
    match media_type {
        XLSX => validate_xlsx(path),
        XLS => {
            let mut header = [0; 512];
            file.read_exact(&mut header).map_err(|error| {
                if error.kind() == std::io::ErrorKind::UnexpectedEof {
                    Error::Invalid("XLS 复合文件头不完整".into())
                } else {
                    storage(error)
                }
            })?;
            let major = u16::from_le_bytes([header[26], header[27]]);
            let shift = u16::from_le_bytes([header[30], header[31]]);
            if header[..8] != [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
                || header[28..30] != [0xfe, 0xff]
                || !matches!((major, shift), (3, 9) | (4, 12))
                || header[32..34] != [6, 0]
                || !size.is_multiple_of(1 << shift)
            {
                return Err(Error::Invalid("XLS 复合文件标识或扇区参数无效".into()));
            }
            Ok(())
        }
        CSV => validate_csv(file),
        _ => Err(Error::Invalid("未知电子表格媒体类型".into())),
    }
}

fn storage(error: std::io::Error) -> Error {
    Error::Storage(error.to_string())
}

fn validate_xlsx(path: &Path) -> Result<()> {
    let mut archive = super::validation::archive(path)?;
    if archive.len() > 512 {
        return Err(Error::TooLarge);
    }
    let mut expanded = 0u64;
    let mut required = [false; 3];
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| Error::Invalid("XLSX 条目无效或已加密".into()))?;
        if !super::validation::safe_entry(entry.name())
            || entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::Invalid("XLSX 条目包含越界路径或符号链接".into()));
        }
        expanded = expanded.checked_add(entry.size()).ok_or(Error::TooLarge)?;
        if entry.size() > 32 * 1024 * 1024 || expanded > 64 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        for (position, name) in ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]
            .iter()
            .enumerate()
        {
            if entry.name() == *name && entry.size() > 0 && !entry.is_dir() {
                required[position] = true;
            }
        }
    }
    if required.iter().any(|found| !found) {
        return Err(Error::Invalid("XLSX 缺少工作簿必要成员".into()));
    }
    Ok(())
}

fn validate_csv(mut file: File) -> Result<()> {
    let mut buffer = [0; 64 * 1024 + 3];
    let mut pending = 0;
    let mut total = 0u64;
    loop {
        let length = file
            .read(&mut buffer[pending..pending + 64 * 1024])
            .map_err(storage)?;
        total = total.checked_add(length as u64).ok_or(Error::TooLarge)?;
        if total > MAX_BYTES {
            return Err(Error::TooLarge);
        }
        if length == 0 {
            return if pending == 0 {
                Ok(())
            } else {
                Err(Error::Invalid("CSV 包含截断的 UTF-8 字符".into()))
            };
        }
        let bytes = &buffer[..pending + length];
        if bytes.contains(&0) {
            return Err(Error::Invalid("CSV 不能包含空字节".into()));
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => pending = 0,
            Err(error) if error.error_len().is_none() => {
                let start = error.valid_up_to();
                let end = bytes.len();
                buffer.copy_within(start..end, 0);
                pending = end - start;
            }
            Err(_) => return Err(Error::Invalid("CSV 必须使用合法 UTF-8".into())),
        }
    }
}
