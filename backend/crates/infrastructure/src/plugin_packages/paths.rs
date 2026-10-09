//! 归档与静态资源共用路径规则，不接受机器目的路径。
use apk_domain::{Error, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn relative(value: &str) -> Result<PathBuf> {
    if value.is_empty()
        || value.len() > 512
        || value.contains(['\\', ':', '\0'])
        || value.starts_with('/')
    {
        return Err(Error::Invalid("包路径必须是有界相对路径".into()));
    }
    for part in value.split('/') {
        let upper = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.starts_with('.')
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
            || (upper.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        {
            return Err(Error::Invalid("包路径包含越界、保留或无效片段".into()));
        }
    }
    Ok(PathBuf::from(value))
}

pub fn existing(root: &Path, path: &str, directory: bool) -> Result<PathBuf> {
    let relative = relative(path)?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| Error::NotFound("包资源不存在".into()))?;
        if metadata.file_type().is_symlink()
            || fs::canonicalize(&current).map_err(|_| Error::Storage("包路径不可访问".into()))?
                != current
        {
            return Err(Error::Invalid("包路径不得含链接或别名".into()));
        }
    }
    let metadata = fs::metadata(&current).map_err(|_| Error::Storage("包资源不可访问".into()))?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(Error::Invalid("包资源类型无效".into()));
    }
    Ok(current)
}

pub fn json<T: serde::de::DeserializeOwned>(root: &Path, path: &str) -> Result<T> {
    use std::io::Read;
    let path = existing(root, path, false)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Storage("包清单读取失败".into()))?
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("包清单读取失败".into()))?;
    if bytes.len() > 65_536 {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("包清单结构无效".into()))
}
