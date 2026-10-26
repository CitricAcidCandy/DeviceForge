//! 独立依赖状态的有限文件读写与路径完整性检查。
use apk_domain::{Error, Result};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub(super) fn io(_: std::io::Error) -> Error {
    Error::Storage("依赖文件操作失败".into())
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

pub(super) fn directory(path: &Path) -> Result<PathBuf> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor)
            && (!metadata.is_dir() || !ordinary(&metadata))
        {
            return Err(Error::Invalid("依赖目录不能经过链接或普通文件".into()));
        }
    }
    fs::create_dir_all(path).map_err(io)?;
    fs::canonicalize(path).map_err(io)
}

pub(super) fn file(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if !metadata.is_file() || !ordinary(&metadata) {
        return Err(Error::Invalid("依赖入口必须是普通文件".into()));
    }
    fs::canonicalize(path).map_err(io)
}

pub(super) fn relative(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['\\', ':', '\0'])
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(Error::Invalid("依赖相对路径越界".into()));
    }
    Ok(path)
}

pub(super) fn json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    file(path)?;
    let file = fs::File::open(path).map_err(io)?;
    if file.metadata().map_err(io)?.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("依赖记录 JSON 无效".into()))
}

pub(super) fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if path.exists() {
        file(path)?;
    }
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Storage("依赖记录编码失败".into()))?;
    if bytes.len() > 256 * 1024 {
        return Err(Error::TooLarge);
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("依赖记录没有父目录".into()))?;
    let parent = directory(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    temporary.write_all(&bytes).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(path).map_err(|error| io(error.error))?;
    Ok(())
}

pub(super) fn state_lock(root: &Path) -> Result<fs::File> {
    let path = root.join("plugin-dependencies/.state.lock");
    if path.exists() {
        file(&path)?;
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(io)?;
    file(&path)?;
    lock.try_lock()
        .map_err(|_| Error::Conflict("依赖状态正在提交，请稍后重试".into()))?;
    Ok(lock)
}
