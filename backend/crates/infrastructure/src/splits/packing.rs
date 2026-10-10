//! 分包输出的选择规则留在薄层，树扫描、APK 结构检查和 ZIP 写入复用公共核心。
use apk_domain::{Error, Result};
use deviceforge_android_package_core::{
    ArchiveProfile, Control, Error as CoreError, LimitKind, TreeProfile,
    archive::{Archive, tree},
};
use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    path::Path,
};

fn mapped(error: CoreError) -> Error {
    match error {
        CoreError::Cancelled => Error::Cancelled,
        CoreError::Timeout => Error::Timeout,
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        CoreError::SourceChanged => Error::Conflict("分包提取输出在打包期间变化".into()),
        CoreError::Io { source, .. } => Error::Storage(source.to_string()),
        CoreError::InvalidArgument(message) | CoreError::InvalidArchive(message) => {
            Error::Invalid(message.into())
        }
        _ => Error::Invalid("分包提取输出无效".into()),
    }
}
fn only_apks(snapshot: &tree::TreeSnapshot) -> Result<()> {
    if snapshot
        .directory()
        .entries()
        .iter()
        .any(|entry| !entry.directory && !entry.name.ends_with(".apk"))
    {
        return Err(Error::Invalid("提取目录只允许 APK 文件".into()));
    }
    Ok(())
}

// Structure 允许保留重名供调用者决策，旧分包入口要求整个内 APK 无重名。
fn validate_inner_apks(
    root: &Path,
    snapshot: &tree::TreeSnapshot,
    control: &Control<'_>,
) -> Result<()> {
    for entry in snapshot
        .directory()
        .entries()
        .iter()
        .filter(|entry| !entry.directory)
    {
        control.check().map_err(mapped)?;
        let file = File::open(root.join(&entry.name))
            .map_err(|error| Error::Storage(error.to_string()))?;
        let archive =
            Archive::open(file, ArchiveProfile::Structure, control).map_err(
                |error| match error {
                    CoreError::LimitExceeded {
                        kind: LimitKind::Entries,
                        ..
                    } => Error::Invalid("压缩包条目超过 10000".into()),
                    CoreError::LimitExceeded {
                        kind: LimitKind::ExpandedBytes,
                        ..
                    } => Error::Invalid("压缩包声明解压体积超过 2 GiB".into()),
                    other => mapped(other),
                },
            )?;
        let mut names = BTreeSet::new();
        for member in archive.directory().entries() {
            control.check().map_err(mapped)?;
            if !names.insert(member.name.as_str()) {
                return Err(Error::Invalid("ZIP 包含重复条目或目录数量不匹配".into()));
            }
        }
    }
    Ok(())
}
pub(super) fn check_controlled(root: &Path, control: &Control<'_>) -> Result<()> {
    let snapshot = tree::scan(root, TreeProfile::Splits, control).map_err(mapped)?;
    only_apks(&snapshot)
}
pub(super) fn pack_controlled(
    root: &Path,
    destination: &Path,
    control: &Control<'_>,
) -> Result<Vec<String>> {
    let snapshot = tree::scan(root, TreeProfile::Splits, control).map_err(mapped)?;
    only_apks(&snapshot)?;
    if !snapshot
        .directory()
        .entries()
        .iter()
        .any(|entry| !entry.directory)
    {
        return Err(Error::Dependency("工具没有生成匹配的 APK".into()));
    }
    validate_inner_apks(root, &snapshot, control)?;
    control.check().map_err(mapped)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| Error::Storage(error.to_string()))?;
    tree::pack(&snapshot, &mut file, control)
        .map(|summary| summary.entries)
        .map_err(mapped)
}
