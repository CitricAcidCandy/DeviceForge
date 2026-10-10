//! 私有副本的字节限额、摘要与归属检查；同步操作只在worker内执行。
use super::FILE_LIMIT;
use crate::{
    config::paths::reparse,
    error::{Error, Result},
};
use deviceforge_android_package_core::Control;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub(crate) fn filename(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name.len() > 500
        || name.contains(['/', '\\', ':'])
        || name == "."
        || name == ".."
        || name.chars().any(char::is_control)
    {
        return Err(Error::Invalid("文件名为空、超限或包含路径"));
    }
    Ok(())
}

fn regular(path: &Path, directory: bool) -> Result<Metadata> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid("产物路径须为绝对路径"));
    }
    let mut found = None;
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| Error::Io("产物路径无法读取"))?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (!metadata.is_file() && !metadata.is_dir())
        {
            return Err(Error::Invalid("产物路径经过链接或特殊文件"));
        }
        if ancestor == path {
            if directory != metadata.is_dir() {
                return Err(Error::Invalid("产物路径类型不符合声明"));
            }
            found = Some(metadata);
        } else if !metadata.is_dir() {
            return Err(Error::Invalid("产物父路径不是目录"));
        }
    }
    found.ok_or(Error::Invalid("产物路径无效"))
}

fn destination(path: &Path) -> Result<File> {
    regular(path.parent().ok_or(Error::Invalid("输出缺少目录"))?, true)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::Io("独占输出文件无法创建"))
}

fn copy(
    source: &Path,
    target: &Path,
    expected: Option<(u64, &str)>,
    control: &Control<'_>,
) -> Result<()> {
    control.check()?;
    let before = regular(source, false)?;
    if before.len() > FILE_LIMIT {
        return Err(Error::TooLarge);
    }
    if expected.is_some_and(|(size, _)| size != before.len()) {
        return Err(Error::Invalid("输入产物长度不一致"));
    }
    let mut input = File::open(source).map_err(|_| Error::Io("输入文件无法打开"))?;
    if !input
        .metadata()
        .map_err(|_| Error::Io("输入文件无法检查"))?
        .is_file()
    {
        return Err(Error::Invalid("输入不是普通文件"));
    }
    control.check()?;
    let mut output = destination(target)?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65_536];
    loop {
        control.check()?;
        let length = input
            .read(&mut buffer)
            .map_err(|_| Error::Io("输入文件无法读取"))?;
        control.check()?;
        if length == 0 {
            break;
        }
        count = count
            .checked_add(length as u64)
            .filter(|size| *size <= FILE_LIMIT)
            .ok_or(Error::TooLarge)?;
        output
            .write_all(&buffer[..length])
            .map_err(|_| Error::Io("输出文件无法写入"))?;
        digest.update(&buffer[..length]);
    }
    if count != before.len()
        || input
            .metadata()
            .map_err(|_| Error::Io("输入文件无法复核"))?
            .len()
            != count
    {
        return Err(Error::Invalid("输入文件在复制中变化"));
    }
    if let Some((size, hash)) = expected
        && (count != size || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(hash))
    {
        return Err(Error::Invalid("输入产物摘要不一致"));
    }
    control.check()?;
    output
        .sync_all()
        .map_err(|_| Error::Io("输出文件刷新失败"))?;
    control.check()?;
    Ok(())
}

pub(super) fn copy_input(
    source: &Path,
    target: &Path,
    size: u64,
    hash: &str,
    control: &Control<'_>,
) -> Result<()> {
    copy(source, target, Some((size, hash)), control)
}
pub(super) fn copy_output(source: &Path, target: &Path, control: &Control<'_>) -> Result<()> {
    copy(source, target, None, control)
}

pub(super) fn write(path: &Path, bytes: &[u8], control: &Control<'_>) -> Result<()> {
    control.check()?;
    let mut file = destination(path)?;
    file.write_all(bytes)
        .map_err(|_| Error::Io("私有配置文件无法写入"))?;
    control.check()?;
    file.sync_all()
        .map_err(|_| Error::Io("私有配置文件刷新失败"))?;
    control.check()?;
    Ok(())
}

pub(super) fn remove_owned(path: &Path) -> Result<()> {
    regular(path, true)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with("deviceforge-android-packages-"))
        .ok_or(Error::CleanupFailed)?;
    let parent = path.parent().ok_or(Error::CleanupFailed)?;
    let expected_parent = fs::canonicalize(parent).map_err(|_| Error::CleanupFailed)?;
    let actual = fs::canonicalize(path).map_err(|_| Error::CleanupFailed)?;
    if actual.parent() != Some(expected_parent.as_path())
        || actual.file_name().and_then(|value| value.to_str()) != Some(name)
    {
        return Err(Error::CleanupFailed);
    }
    fs::remove_dir_all(&actual).map_err(|_| Error::CleanupFailed)
}
