//! 通用工具目录索引可从不可变内容重建，缓存不参与锁、租约或删除裁定。
use crate::{Error, ReadLease, Result, ToolKey, WriteGuard, paths};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIndexEntry {
    pub key: ToolKey,
    pub entries: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIndex {
    pub format_version: u32,
    pub tools: Vec<ToolIndexEntry>,
}

fn directories(root: &Path, visited: &mut usize, check: &dyn Fn() -> Result<()>) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(root)? {
        check()?;
        *visited += 1;
        if *visited > 131072 {
            return Err(Error::TooLarge);
        }
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| Error::Invalid("工具目录不是 UTF-8"))?;
        if name.starts_with('.') {
            continue;
        }
        paths::segment(&name)?;
        paths::directory(&entry.path())?;
        names.push(name);
    }
    names.sort();
    Ok(names)
}

fn scan(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<ToolIndex> {
    let mut tools = Vec::new();
    let mut visited = 0;
    for id in directories(root, &mut visited, check)? {
        for version in directories(&root.join(&id), &mut visited, check)? {
            for platform in directories(&root.join(&id).join(&version), &mut visited, check)? {
                let parent = root.join(&id).join(&version).join(&platform);
                for sha256 in directories(&parent, &mut visited, check)? {
                    let key = ToolKey { id: id.clone(), version: version.clone(), platform: platform.clone(), sha256 };
                    key.validate()?;
                    let directory = paths::existing_directory(root, &key.relative()?)?;
                    let inventory: BTreeMap<String, serde_json::Value> = paths::read(&directory.join("inventory.json"), 16 * 1024 * 1024)?;
                    if inventory.is_empty() || inventory.len() > 32768 || tools.len() >= 32768 {
                        return Err(Error::TooLarge);
                    }
                    let mut entries = Vec::new();
                    for entry in inventory.into_keys() {
                        let path = Path::new(&entry);
                        if entry.contains('\\') || path.is_absolute() || path.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
                            return Err(Error::Invalid("工具索引入口越界"));
                        }
                        entries.push(entry);
                    }
                    tools.push(ToolIndexEntry { key, entries });
                }
            }
        }
    }
    Ok(ToolIndex { format_version: 1, tools })
}

impl ReadLease {
    /// 枚举整个共享仓库；索引只用于定位，复用前仍须 verify/verify_entry。
    pub fn tool_index(&self, check: &dyn Fn() -> Result<()>) -> Result<ToolIndex> {
        scan(self.repository.root(), check)
    }
}

impl WriteGuard {
    /// 派生缓存丢失或损坏不影响工具内容；重建期间继续持有既有仓库写锁。
    pub fn rebuild_tool_index(&self, check: &dyn Fn() -> Result<()>) -> Result<ToolIndex> {
        let index = scan(self.repository.root(), check)?;
        check()?;
        paths::write(&self.repository.root().join(".repository/index.json"), &index)?;
        Ok(index)
    }
}
