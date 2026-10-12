//! 文件资格与有界副本；只操作本次私有目录及本次创建的输出。
use crate::{Error, Result, input};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
};
pub(crate) const FILE_LIMIT: u64 = 64 * 1024 * 1024;

pub(crate) fn absolute(path: &Path) -> Result<()> {
    input::text(path.to_str().ok_or(Error::Invalid("路径须为UTF-8"))?, 4096)?;
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(Error::Invalid("路径须为不含父路径的绝对路径"));
    }
    Ok(())
}
fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}
pub(crate) fn regular(path: &Path, directory: bool) -> Result<Metadata> {
    absolute(path)?;
    let mut found = None;
    for ancestor in path.ancestors() {
        let metadata =
            std::fs::symlink_metadata(ancestor).map_err(|_| Error::Io("路径不可读取"))?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (!metadata.is_dir() && !metadata.is_file())
        {
            return Err(Error::Invalid("路径经过链接、重解析点或特殊文件"));
        }
        if ancestor == path {
            if metadata.is_dir() != directory {
                return Err(Error::Invalid("文件或目录资格不符"));
            }
            found = Some(metadata);
        } else if !metadata.is_dir() {
            return Err(Error::Invalid("祖先不是目录"));
        }
    }
    found.ok_or(Error::Invalid("路径无实际文件"))
}
fn opened(path: &Path, file: &File, before: &Metadata) -> Result<()> {
    let current = regular(path, false)?;
    let handle = file.metadata().map_err(|_| Error::Io("文件句柄不可读取"))?;
    if current.len() != before.len()
        || handle.len() != before.len()
        || current.modified().ok() != before.modified().ok()
        || handle.modified().ok() != before.modified().ok()
    {
        return Err(Error::Invalid("文件在使用期间改变"));
    }
    Ok(())
}
pub(crate) fn create(path: &Path) -> Result<File> {
    regular(path.parent().ok_or(Error::Invalid("文件没有父目录"))?, true)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::Io("文件已存在或无法创建"))
}
pub(crate) fn read(path: &Path, maximum: u64, check: impl Fn() -> Result<()>) -> Result<Vec<u8>> {
    check()?;
    let metadata = regular(path, false)?;
    if metadata.len() > maximum {
        return Err(Error::TooLarge);
    }
    let mut file = File::open(path).map_err(|_| Error::Io("文件无法打开"))?;
    opened(path, &file, &metadata)?;
    let mut data = Vec::new();
    let mut buffer = [0u8; 65536];
    loop {
        check()?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| Error::Io("文件无法读取"))?;
        if count == 0 {
            break;
        }
        if data.len() as u64 + count as u64 > maximum {
            return Err(Error::TooLarge);
        }
        data.extend_from_slice(&buffer[..count]);
    }
    opened(path, &file, &metadata)?;
    check()?;
    Ok(data)
}
pub(crate) fn write(path: &Path, data: &[u8], check: impl Fn() -> Result<()>) -> Result<()> {
    check()?;
    let mut file = create(path)?;
    for chunk in data.chunks(65536) {
        check()?;
        file.write_all(chunk)
            .map_err(|_| Error::Io("文件无法写入"))?;
    }
    file.flush().map_err(|_| Error::Io("文件无法刷新"))?;
    check()?;
    Ok(())
}
pub(crate) fn verify(data: &[u8], size: u64, expected: &str) -> Result<()> {
    if data.len() as u64 != size
        || expected.len() != 64
        || !format!("{:x}", Sha256::digest(data)).eq_ignore_ascii_case(expected)
    {
        return Err(Error::Invalid("输入产物大小或SHA256不一致"));
    }
    Ok(())
}
