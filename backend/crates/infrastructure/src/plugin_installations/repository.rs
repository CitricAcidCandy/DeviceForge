//! 宿主只维护自身引用快照；不可变工具的锁、发布和移除由公开仓库统一负责。
use super::{FilePluginInstallations, storage, transaction};
use apk_domain::{
    Error, Result,
    plugin_installations::{InstalledRelease, InstalledTool},
};
use deviceforge_tool_repository::{Repository, ToolKey, WriteGuard};
use std::{fs, path::Path};

pub(super) fn error(error: deviceforge_tool_repository::Error) -> Error {
    use deviceforge_tool_repository::Error as Shared;
    match error {
        Shared::Busy | Shared::InUse => Error::Conflict(error.to_string()),
        Shared::Invalid(message) => Error::Invalid(message.into()),
        Shared::TooLarge => Error::TooLarge,
        Shared::Cancelled => Error::Cancelled,
        Shared::Timeout => Error::Timeout,
        Shared::Io(_) => Error::Storage("共享工具仓库操作失败".into()),
    }
}
pub(super) fn open(root: &Path) -> Result<Repository> {
    Repository::open(&root.join("tools")).map_err(error)
}
pub(super) fn key(tool: &InstalledTool) -> ToolKey {
    ToolKey {
        id: tool.id.clone(),
        version: tool.version.clone(),
        platform: tool.platform.clone(),
        sha256: tool.sha256.clone(),
    }
}
pub(super) fn sync_root(
    root: &Path,
    writer: &WriteGuard,
    extra: &[InstalledRelease],
) -> Result<()> {
    let mut records = Vec::new();
    for (count, entry) in fs::read_dir(root.join("installations/releases"))
        .map_err(|_| Error::Storage("共享工具引用目录不可读".into()))?
        .enumerate()
    {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let entry = entry.map_err(|_| Error::Storage("共享工具引用记录不可读".into()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_suffix(".json")
            .ok_or_else(|| Error::Invalid("安装记录文件名无效".into()))?;
        if let Some(record) = storage::read_optional(root, id)? {
            records.push(record);
        }
    }
    records.extend(transaction::retained_records(root)?);
    records.extend_from_slice(extra);
    let tools = records
        .iter()
        .flat_map(|record| record.tools.iter().map(key))
        .collect::<Vec<_>>();
    writer
        .set_references("host-installations", &tools)
        .map_err(error)
}
pub(super) fn sync(
    store: &FilePluginInstallations,
    writer: &WriteGuard,
    extra: &[InstalledRelease],
) -> Result<()> {
    sync_root(&store.root, writer, extra)
}
