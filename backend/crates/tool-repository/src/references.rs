//! 引用快照不读取宿主内部安装记录，由各调用方显式维护自己的命名空间。
use crate::{Error, Result, ToolKey, paths};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct References {
    format_version: u32,
    owner: String,
    tools: Vec<ToolKey>,
}

pub(crate) fn replace(root: &Path, owner: &str, keys: &[ToolKey]) -> Result<()> {
    paths::segment(owner)?;
    if keys.len() > 32768 {
        return Err(Error::TooLarge);
    }
    for key in keys {
        key.validate()?;
    }
    let keys = keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let snapshot = References {
        format_version: 1,
        owner: owner.into(),
        tools: keys,
    };
    paths::write(
        &root
            .join(".repository/references")
            .join(format!("{owner}.json")),
        &snapshot,
    )
}

pub(crate) fn owners(root: &Path, key: &ToolKey) -> Result<Vec<String>> {
    key.validate()?;
    let mut owners = Vec::new();
    let directory = paths::existing_directory(root, Path::new(".repository/references"))?;
    for (count, entry) in fs::read_dir(directory)?.enumerate() {
        if count >= 1024 {
            return Err(Error::TooLarge);
        }
        let path = entry?.path();
        let owner = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or(Error::Invalid("仓库引用文件名无效"))?;
        paths::segment(owner)?;
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            return Err(Error::Invalid("仓库引用包含未知记录"));
        }
        let snapshot: References = paths::read(&path, 32 * 1024 * 1024)?;
        if snapshot.format_version != 1 || snapshot.owner != owner || snapshot.tools.len() > 32768 {
            return Err(Error::Invalid("仓库引用结构或身份无效"));
        }
        for tool in &snapshot.tools {
            tool.validate()?;
        }
        if snapshot.tools.iter().any(|tool| tool == key) {
            owners.push(snapshot.owner);
        }
    }
    owners.sort();
    Ok(owners)
}

pub(crate) fn clear_temporary(root: &Path, owner: &str) -> Result<()> {
    paths::segment(owner)?;
    let directory = paths::existing_directory(root, Path::new(".repository/references"))?;
    let path = directory.join(format!("{owner}.json"));
    if !path.exists() {
        return Ok(());
    }
    let snapshot: References = paths::read(&path, 32 * 1024 * 1024)?;
    if snapshot.format_version != 1 || snapshot.owner != owner {
        return Err(Error::Invalid("临时引用归属无效，拒绝删除"));
    }
    fs::remove_file(path)?;
    Ok(())
}
