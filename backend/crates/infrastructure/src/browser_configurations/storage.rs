//! 有界文件读取与原子发布，仅在配置存储的阻塞工作和互斥内调用。
use apk_domain::{Error, Result, browser_configurations::*};
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

pub(super) fn check_directory(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Error::Storage("浏览器配置目录不可访问".into()))?;
    if !metadata.is_dir() || !ordinary(&metadata) {
        return Err(Error::Invalid("浏览器配置目录必须为普通目录".into()));
    }
    Ok(())
}

fn check_file(path: &Path) -> Result<fs::Metadata> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Error::Storage("浏览器配置文件不可访问".into()))?;
    if !metadata.is_file() || !ordinary(&metadata) {
        return Err(Error::Invalid("浏览器配置必须为普通文件".into()));
    }
    Ok(metadata)
}

pub(super) fn open_root(root: &Path) -> Result<PathBuf> {
    let absolute =
        std::path::absolute(root).map_err(|_| Error::Invalid("浏览器配置根目录无效".into()))?;
    // 创建前检查所有已存在的祖先，避免通过目录链接写到预期根之外。
    for ancestor in absolute.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => check_directory(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage("浏览器配置目录不可访问".into())),
        }
    }
    fs::create_dir_all(&absolute).map_err(|_| Error::Storage("浏览器配置根目录创建失败".into()))?;
    check_directory(&absolute)?;
    fs::canonicalize(absolute).map_err(|_| Error::Storage("浏览器配置根目录不可访问".into()))
}

pub(super) fn lock(root: &Path) -> Result<fs::File> {
    let path = root.join(".configurations.lock");
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            check_file(&path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Storage("浏览器配置存储锁不可访问".into())),
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|_| Error::Storage("浏览器配置存储锁不可访问".into()))?;
    check_file(&path)?;
    file.try_lock()
        .map_err(|_| Error::Conflict("浏览器配置目录已由其他宿主占用".into()))?;
    Ok(file)
}

fn directory(root: &Path, id: &str, create: bool) -> Result<Option<PathBuf>> {
    let path = root.join(id);
    if path.parent() != Some(root) {
        return Err(Error::Invalid("浏览器配置目录越界".into()));
    }
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
            return Ok(None);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(|_| Error::Storage("浏览器配置目录创建失败".into()))?;
        }
        Err(_) => return Err(Error::Storage("浏览器配置目录不可访问".into())),
    }
    check_directory(&path)?;
    if fs::canonicalize(&path).map_err(|_| Error::Storage("浏览器配置目录不可访问".into()))? != path
    {
        return Err(Error::Invalid("浏览器配置目录越界".into()));
    }
    Ok(Some(path))
}

pub(super) fn read(root: &Path, id: &str) -> Result<Option<BrowserConfigurationRecord>> {
    let Some(directory) = directory(root, id, false)? else {
        return Ok(None);
    };
    let path = directory.join("state.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Storage("浏览器配置文件不可访问".into())),
    }
    let metadata = check_file(&path)?;
    if metadata.len() > BROWSER_CONFIGURATION_LIMIT as u64 {
        return Err(Error::TooLarge);
    }
    let file = fs::File::open(&path).map_err(|_| Error::Storage("浏览器配置文件不可读".into()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(BROWSER_CONFIGURATION_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("浏览器配置文件读取失败".into()))?;
    if bytes.len() > BROWSER_CONFIGURATION_LIMIT {
        return Err(Error::TooLarge);
    }
    let record: BrowserConfigurationRecord = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("浏览器配置记录不是有效的 JSON".into()))?;
    record.validate()?;
    Ok(Some(record))
}

pub(super) fn write(root: &Path, id: &str, record: &BrowserConfigurationRecord) -> Result<()> {
    let bytes =
        serde_json::to_vec(record).map_err(|_| Error::Storage("浏览器配置序列化失败".into()))?;
    if bytes.len() > BROWSER_CONFIGURATION_LIMIT {
        return Err(Error::TooLarge);
    }
    let directory = directory(root, id, true)?
        .ok_or_else(|| Error::Storage("浏览器配置目录创建失败".into()))?;
    let path = directory.join("state.json");
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| Error::Storage("浏览器配置暂存失败".into()))?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| Error::Storage("浏览器配置写入失败".into()))?;
    file.persist(path)
        .map_err(|_| Error::Storage("浏览器配置发布失败".into()))?;
    Ok(())
}
