//! 固定部署目录下的可选展示资料；缺失或损坏不影响插件贡献加载。
use apk_domain::{Error, Result, plugins::PluginDisplayMetadata};
use serde::Deserialize;
use std::{fs, io::Read, path::Path};

const MAXIMUM_BYTES: u64 = 65536;

#[derive(Deserialize)]
struct Descriptor {
    metadata_version: u32,
    id: String,
    version: String,
    name: String,
    summary: String,
    description: String,
}

fn ordinary_file(metadata: &fs::Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Windows 的其他重解析点也不能作为展示资料来源。
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

fn descriptor(directory: &Path, id: &str, version: &str) -> Result<Option<PluginDisplayMetadata>> {
    let directory =
        fs::canonicalize(directory).map_err(|_| Error::Storage("插件展示目录不可访问".into()))?;
    let path = directory.join("market.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Storage("插件展示资料不可访问".into())),
    };
    if !ordinary_file(&metadata)
        || fs::canonicalize(&path).map_err(|_| Error::Storage("插件展示资料不可访问".into()))?
            != path
    {
        return Err(Error::Invalid("插件展示资料必须是普通部署文件".into()));
    }
    if metadata.len() > MAXIMUM_BYTES {
        return Err(Error::TooLarge);
    }
    let file = fs::File::open(&path).map_err(|_| Error::Storage("插件展示资料读取失败".into()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAXIMUM_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("插件展示资料读取失败".into()))?;
    if bytes.len() > MAXIMUM_BYTES as usize {
        return Err(Error::TooLarge);
    }
    let descriptor: Descriptor = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("插件展示资料不符合公开格式".into()))?;
    if descriptor.metadata_version != 1 || descriptor.id != id || descriptor.version != version {
        return Err(Error::Invalid("插件展示资料身份与清单不一致".into()));
    }
    for (text, maximum) in [
        (&descriptor.name, 200),
        (&descriptor.summary, 2000),
        (&descriptor.description, 20000),
    ] {
        if text.trim().is_empty() || text.len() > maximum || text.contains('\0') {
            return Err(Error::Invalid("插件展示文本为空或超过限制".into()));
        }
    }
    Ok(Some(PluginDisplayMetadata {
        name: descriptor.name,
        summary: descriptor.summary,
        description: descriptor.description,
    }))
}

pub(crate) fn read(directory: &Path, id: &str, version: &str) -> Option<PluginDisplayMetadata> {
    match descriptor(directory, id, version) {
        Ok(metadata) => metadata,
        Err(_) => {
            // 不记录原始文本、路径或解析异常，避免把包内未知资料写入日志。
            tracing::warn!(plugin_id = id, "插件展示资料无效，沿用标识展示");
            None
        }
    }
}
