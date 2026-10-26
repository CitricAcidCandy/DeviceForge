//! 通用工具目录索引可从不可变内容重建，缓存不参与锁、租约或删除裁定。
use crate::{Error, ReadLease, Result, ToolKey, WriteGuard, paths};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIndexEntry {
    pub key: ToolKey,
    pub entries: BTreeMap<String, String>,
    pub runtime_version: String,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    format_version: u32,
    key: ToolKey,
    runtime_version: String,
    entries: BTreeMap<String, String>,
}

fn metadata_name(key: &ToolKey) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(key).map_err(|_| Error::Invalid("工具索引身份无法编码"))?;
    Ok(format!("{:x}.json", Sha256::digest(bytes)))
}

fn validate_metadata(metadata: &Metadata, key: &ToolKey) -> Result<()> {
    if metadata.format_version != 1
        || metadata.key != *key
        || metadata.runtime_version.is_empty()
        || metadata.runtime_version.len() > 128
        || metadata.entries.is_empty()
        || metadata.entries.len() > 64
    {
        return Err(Error::Invalid("工具索引元数据身份或入口数量无效"));
    }
    for (id, relative) in &metadata.entries {
        paths::segment(id)?;
        let path = Path::new(relative);
        if relative.is_empty()
            || relative.contains(['\\', ':'])
            || path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(Error::Invalid("工具索引入口越界"));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIndex {
    pub format_version: u32,
    pub tools: Vec<ToolIndexEntry>,
}

fn directories(
    root: &Path,
    visited: &mut usize,
    check: &dyn Fn() -> Result<()>,
) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(root)? {
        check()?;
        *visited += 1;
        if *visited > 131072 {
            return Err(Error::TooLarge);
        }
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::Invalid("工具目录不是 UTF-8"))?;
        if name.starts_with('.') {
            continue;
        }
        if paths::segment(&name).is_err() || !entry.file_type()?.is_dir() {
            continue;
        }
        paths::directory(&entry.path())?;
        names.push(name);
    }
    names.sort();
    Ok(names)
}

fn scan(
    root: &Path,
    filter: Option<(&str, &str)>,
    check: &dyn Fn() -> Result<()>,
) -> Result<ToolIndex> {
    check()?;
    let mut tools = Vec::new();
    let mut visited = 0;
    for id in directories(root, &mut visited, check)? {
        if filter.is_some_and(|(expected, _)| expected != id) {
            continue;
        }
        for version in directories(&root.join(&id), &mut visited, check)? {
            for platform in directories(&root.join(&id).join(&version), &mut visited, check)? {
                if filter.is_some_and(|(_, expected)| expected != platform) {
                    continue;
                }
                let parent = root.join(&id).join(&version).join(&platform);
                for sha256 in directories(&parent, &mut visited, check)? {
                    if !parent.join(&sha256).join("inventory.json").is_file() {
                        // 用户自备的普通目录不属于已提交仓库内容，仍可由声明位置单独发现。
                        continue;
                    }
                    let key = ToolKey {
                        id: id.clone(),
                        version: version.clone(),
                        platform: platform.clone(),
                        sha256,
                    };
                    key.validate()?;
                    let directory = paths::existing_directory(root, &key.relative()?)?;
                    let inventory: BTreeMap<String, serde_json::Value> =
                        paths::read(&directory.join("inventory.json"), 16 * 1024 * 1024)?;
                    if inventory.is_empty() || inventory.len() > 32768 || tools.len() >= 32768 {
                        return Err(Error::TooLarge);
                    }
                    let mut files = Vec::new();
                    for entry in inventory.into_keys() {
                        check()?;
                        let path = Path::new(&entry);
                        if entry.contains('\\')
                            || path.is_absolute()
                            || path
                                .components()
                                .any(|part| !matches!(part, std::path::Component::Normal(_)))
                        {
                            return Err(Error::Invalid("工具索引入口越界"));
                        }
                        files.push(entry);
                    }
                    let metadata_path = root
                        .join(".repository/tool-metadata")
                        .join(metadata_name(&key)?);
                    let (entries, runtime_version) = if metadata_path.exists() {
                        paths::existing_directory(root, Path::new(".repository/tool-metadata"))?;
                        let metadata: Metadata = paths::read(&metadata_path, 65536)?;
                        validate_metadata(&metadata, &key)?;
                        if metadata
                            .entries
                            .values()
                            .any(|entry| !files.contains(entry))
                        {
                            return Err(Error::Invalid("工具索引入口不在内容清单内"));
                        }
                        (metadata.entries, metadata.runtime_version)
                    } else {
                        (BTreeMap::new(), key.version.clone())
                    };
                    tools.push(ToolIndexEntry {
                        key,
                        entries,
                        runtime_version,
                        files,
                    });
                }
            }
        }
    }
    Ok(ToolIndex {
        format_version: 1,
        tools,
    })
}

impl ReadLease {
    /// 枚举整个共享仓库；索引只用于定位，复用前仍须 verify/verify_entry。
    pub fn tool_index(&self, check: &dyn Fn() -> Result<()>) -> Result<ToolIndex> {
        scan(self.repository.root(), None, check)
    }

    /// 单项发现不读取其他工具的内容元数据，避免无关历史损坏污染独立调用。
    pub fn tool_index_for(
        &self,
        id: &str,
        platform: &str,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<ToolIndex> {
        paths::segment(id)?;
        paths::segment(platform)?;
        scan(self.repository.root(), Some((id, platform)), check)
    }
}

impl WriteGuard {
    /// 稳定资源键与运行版本独立记录，使其他插件无需复制下载来源或内部布局即可复用。
    pub fn register_tool(
        &self,
        key: &ToolKey,
        runtime_version: &str,
        entries: &BTreeMap<String, String>,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        let metadata = Metadata {
            format_version: 1,
            key: key.clone(),
            runtime_version: runtime_version.into(),
            entries: entries.clone(),
        };
        validate_metadata(&metadata, key)?;
        let root = self.verify(key, check)?;
        for relative in entries.values() {
            check()?;
            let path = root.join(relative);
            paths::file(&path)?;
            if fs::canonicalize(&path)? != path {
                return Err(Error::Invalid("索引入口经过链接"));
            }
        }
        let directory = paths::create_directory(
            self.repository.root(),
            Path::new(".repository/tool-metadata"),
        )?;
        let destination = directory.join(metadata_name(key)?);
        if destination.exists() {
            let existing: Metadata = paths::read(&destination, 65536)?;
            validate_metadata(&existing, key)?;
            if existing.runtime_version != metadata.runtime_version
                || existing.entries != metadata.entries
            {
                return Err(Error::Invalid("同一不可变工具已有不同的稳定入口描述"));
            }
            return Ok(());
        }
        paths::write(&destination, &metadata)
    }

    /// 派生缓存丢失或损坏不影响工具内容；重建期间继续持有既有仓库写锁。
    pub fn rebuild_tool_index(&self, check: &dyn Fn() -> Result<()>) -> Result<ToolIndex> {
        let index = scan(self.repository.root(), None, check)?;
        check()?;
        paths::write(
            &self.repository.root().join(".repository/index.json"),
            &index,
        )?;
        Ok(index)
    }
}
