//! 共享仓库的规范路径与普通文件边界；Windows 重解析点按链接拒绝。
use crate::{Error, Result};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub(crate) fn segment(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.+".contains(&byte))
        || value.ends_with('.')
        || value.starts_with('.')
    {
        return Err(Error::Invalid("仓库标识必须是有界安全路径段"));
    }
    let base = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&base.as_str())
    {
        return Err(Error::Invalid("仓库标识不能是设备保留名"));
    }
    Ok(())
}
fn ordinary(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}
pub(crate) fn directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || !ordinary(&metadata) {
        return Err(Error::Invalid("仓库目录必须是普通目录"));
    }
    Ok(())
}
pub(crate) fn file(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || !ordinary(&metadata) {
        return Err(Error::Invalid("仓库资源必须是普通文件"));
    }
    Ok(metadata)
}
pub(crate) fn open_root(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::Invalid("仓库根必须是绝对路径"));
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => directory(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    fs::create_dir_all(path)?;
    Ok(fs::canonicalize(path)?)
}
fn relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(Error::Invalid("仓库相对路径越界"));
    }
    Ok(())
}
pub(crate) fn create_directory(root: &Path, path: &Path) -> Result<PathBuf> {
    relative(path)?;
    let mut current = root.to_owned();
    for part in path.components() {
        current.push(part);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        directory(&current)?;
        if fs::canonicalize(&current)? != current {
            return Err(Error::Invalid("仓库目录越界"));
        }
    }
    Ok(current)
}
pub(crate) fn existing_directory(root: &Path, path: &Path) -> Result<PathBuf> {
    relative(path)?;
    let mut current = root.to_owned();
    for part in path.components() {
        current.push(part);
        directory(&current)?;
        if fs::canonicalize(&current)? != current {
            return Err(Error::Invalid("仓库目录越界"));
        }
    }
    Ok(current)
}
pub(crate) fn read<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<T> {
    if file(path)?.len() > limit {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("仓库记录 JSON 无效"))
}
pub(crate) fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        file(path)?;
    }
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Invalid("仓库记录无法编码"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(
        path.parent().ok_or(Error::Invalid("仓库记录没有父目录"))?,
    )?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| Error::Io(error.error))?;
    Ok(())
}
