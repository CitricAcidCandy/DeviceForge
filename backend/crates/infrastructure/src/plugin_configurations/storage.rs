//! 不可变修订与小型状态指针；所有调用均处于受限阻塞工作内。
use apk_domain::{Error, Result, plugin_configurations::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const LIMIT: u64 = 256 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct State {
    #[serde(default)]
    pub definition_version: u32,
    pub revision: u64,
    pub applied_revision: u64,
    pub values: Value,
    pub source: ConfigurationSource,
}

pub(super) fn json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| Error::NotFound("配置文件不存在".into()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("配置必须为普通文件".into()));
    }
    if metadata.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Storage("配置文件不可读".into()))?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("配置读取失败".into()))?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("配置文件不是有效的 JSON".into()))
}

pub(super) fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Storage("配置序列化失败".into()))?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error::TooLarge);
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::Storage("配置目录无效".into()))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| Error::Storage("配置暂存失败".into()))?;
    file.write_all(&bytes)
        .map_err(|_| Error::Storage("配置写入失败".into()))?;
    file.as_file()
        .sync_all()
        .map_err(|_| Error::Storage("配置刷新失败".into()))?;
    file.persist(path)
        .map_err(|_| Error::Storage("配置发布失败".into()))?;
    Ok(())
}

pub(super) fn revision_path(root: &Path, id: &str, revision: u64) -> PathBuf {
    root.join(id).join(format!("{revision}.json"))
}

pub(super) fn ensure_revision(
    root: &Path,
    id: &str,
    revision: u64,
    values: &Value,
) -> Result<PathBuf> {
    let directory = root.join(id);
    fs::create_dir_all(&directory).map_err(|_| Error::Storage("配置修订目录创建失败".into()))?;
    let path = revision_path(root, id, revision);
    if path.exists() {
        let existing: Value = json(&path)?;
        if existing != *values {
            return Err(Error::Conflict("配置不可变修订已存在不同内容".into()));
        }
    } else {
        let bytes =
            serde_json::to_vec(values).map_err(|_| Error::Storage("配置序列化失败".into()))?;
        if bytes.len() as u64 > LIMIT {
            return Err(Error::TooLarge);
        }
        let mut file = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| Error::Storage("配置修订创建失败".into()))?;
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| Error::Storage("配置修订写入失败".into()))?;
        file.persist_noclobber(&path)
            .map_err(|_| Error::Storage("配置修订发布失败".into()))?;
    }
    Ok(path)
}
