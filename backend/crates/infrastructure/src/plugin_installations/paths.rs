//! 安装器路径边界，只接受经过验证的用户根子路径。
use apk_domain::{Error, Result, plugin_installations::validate_release_path};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

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
pub(super) fn directory(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Error::Storage("安装目录不可访问".into()))?;
    if !metadata.is_dir() || !ordinary(&metadata) {
        return Err(Error::Invalid("安装目录必须为普通目录".into()));
    }
    Ok(())
}
pub(super) fn file(path: &Path) -> Result<fs::Metadata> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Error::NotFound("安装资源不存在".into()))?;
    if !metadata.is_file() || !ordinary(&metadata) {
        return Err(Error::Invalid("安装资源必须为普通文件".into()));
    }
    Ok(metadata)
}
pub(super) fn open_root(path: &Path) -> Result<PathBuf> {
    let path = std::path::absolute(path).map_err(|_| Error::Invalid("用户安装根无效".into()))?;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => directory(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage("用户目录不可访问".into())),
        }
    }
    fs::create_dir_all(&path).map_err(|_| Error::Storage("用户安装根创建失败".into()))?;
    fs::canonicalize(path).map_err(|_| Error::Storage("用户安装根不可访问".into()))
}
pub(super) fn external_file(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::Invalid("Node 入口必须为绝对文件".into()));
    }
    file(path)?;
    fs::canonicalize(path).map_err(|_| Error::Storage("Node 程序不可访问".into()))
}
pub(super) fn create_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_release_path(relative)?;
    let mut current = root.to_owned();
    for part in relative.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| Error::Storage("安装子目录创建失败".into()))?
            }
            Err(_) => return Err(Error::Storage("安装子目录不可访问".into())),
        }
        directory(&current)?;
        if fs::canonicalize(&current).map_err(|_| Error::Storage("安装目录不可访问".into()))?
            != current
        {
            return Err(Error::Invalid("安装目录越界".into()));
        }
    }
    Ok(current)
}
pub(super) fn existing(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_release_path(relative)?;
    let mut current = root.to_owned();
    let parts: Vec<_> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        if index + 1 == parts.len() {
            file(&current)?;
        } else {
            directory(&current)?;
        }
        if fs::canonicalize(&current).map_err(|_| Error::Storage("安装资源不可访问".into()))?
            != current
        {
            return Err(Error::Invalid("安装资源越界".into()));
        }
    }
    Ok(current)
}
pub(super) fn lock(path: &Path) -> Result<fs::File> {
    if fs::symlink_metadata(path).is_ok() {
        file(path)?;
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| Error::Storage("安装锁不可访问".into()))?;
    self::file(path)?;
    file.try_lock()
        .map_err(|_| Error::Conflict("用户插件目录已由其他宿主占用".into()))?;
    Ok(file)
}
pub(super) fn read<T: DeserializeOwned>(path: &Path, limit: usize) -> Result<T> {
    let metadata = file(path)?;
    if metadata.len() > limit as u64 {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Storage("安装记录读取失败".into()))?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("安装记录读取失败".into()))?;
    if bytes.len() > limit {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("安装记录结构损坏".into()))
}
pub(super) fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Storage("安装记录编码失败".into()))?;
    write_bytes(path, &bytes)
}
pub(super) fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        file(path)?;
    }
    let mut temporary = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| Error::Invalid("安装记录路径无效".into()))?,
    )
    .map_err(|_| Error::Storage("安装记录暂存失败".into()))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| Error::Storage("安装记录刷新失败".into()))?;
    temporary
        .persist(path)
        .map_err(|_| Error::Storage("安装记录发布失败".into()))?;
    Ok(())
}

pub(super) fn clean_staging(root: &Path) -> Result<()> {
    let staging = root.join("installations/staging");
    directory(&staging)?;
    for (count, entry) in fs::read_dir(&staging)
        .map_err(|_| Error::Storage("安装暂存清理目录不可读".into()))?
        .enumerate()
    {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let path = entry
            .map_err(|_| Error::Storage("安装暂存条目不可读".into()))?
            .path();
        directory(&path)?;
        let canonical =
            fs::canonicalize(&path).map_err(|_| Error::Storage("安装暂存路径不可读".into()))?;
        if canonical != path || !canonical.starts_with(&staging) || canonical == staging {
            return Err(Error::Invalid("安装暂存清理路径越界".into()));
        }
        fs::remove_dir_all(canonical).map_err(|_| Error::Storage("上次安装暂存清理失败".into()))?;
    }
    Ok(())
}
