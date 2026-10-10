use super::{ArchiveEntry, Directory, paths};
use crate::{
    Control, Error, IoStage, LimitKind, PackedTree, Result, TreeProfile,
    profiles::{MAX_FILE_BYTES, MAX_TREE_DEPTH},
};
use std::{
    fs::{self, File, Metadata},
    path::{Path, PathBuf},
};

/// 只由实际扫描产生，根目录不序列化；它不锁定同长度文件内容。
#[derive(Debug)]
pub struct TreeSnapshot {
    pub(super) root: PathBuf,
    pub(super) profile: TreeProfile,
    pub(super) directory: Directory,
}

impl TreeSnapshot {
    pub fn directory(&self) -> &Directory {
        &self.directory
    }
    pub fn profile(&self) -> TreeProfile {
        self.profile
    }
}

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

pub(super) fn checked_metadata(path: &Path, control: &Control<'_>) -> Result<Metadata> {
    control.check()?;
    let metadata = fs::symlink_metadata(path).map_err(|e| Error::io(IoStage::Metadata, e))?;
    if metadata.file_type().is_symlink()
        || reparse(&metadata)
        || (!metadata.is_file() && !metadata.is_dir())
    {
        return Err(Error::InvalidArchive("树包含链接、重解析点或特殊文件"));
    }
    control.check()?;
    let canonical = fs::canonicalize(path).map_err(|e| Error::io(IoStage::Metadata, e))?;
    if canonical != path {
        return Err(Error::InvalidArchive("树路径经过链接或重解析"));
    }
    control.check()?;
    Ok(metadata)
}

pub fn scan(root: &Path, profile: TreeProfile, control: &Control<'_>) -> Result<TreeSnapshot> {
    control.check()?;
    let initial = fs::symlink_metadata(root).map_err(|e| Error::io(IoStage::Metadata, e))?;
    if !initial.is_dir() || initial.file_type().is_symlink() || reparse(&initial) {
        return Err(Error::InvalidArgument("树根必须为普通目录"));
    }
    control.check()?;
    let canonical = fs::canonicalize(root).map_err(|e| Error::io(IoStage::Metadata, e))?;
    // 根的每段也核对链接；canonicalize 本身不能证明原路径没有经过链接。
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        control.check()?;
        std::env::current_dir()
            .map_err(|e| Error::io(IoStage::Directory, e))?
            .join(root)
    };
    for ancestor in absolute.ancestors() {
        control.check()?;
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|e| Error::io(IoStage::Metadata, e))?;
        if metadata.file_type().is_symlink() || reparse(&metadata) {
            return Err(Error::InvalidArchive("树根经过链接或重解析"));
        }
    }
    checked_metadata(&canonical, control)?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    let mut pending = vec![(canonical.clone(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        checked_metadata(&directory, control)?;
        control.check()?;
        let children = fs::read_dir(&directory).map_err(|e| Error::io(IoStage::Directory, e))?;
        for child in children {
            control.check()?;
            let child = child.map_err(|e| Error::io(IoStage::Directory, e))?;
            if entries.len() >= profile.entry_limit() {
                return Err(Error::limit(
                    LimitKind::Entries,
                    profile.entry_limit() as u64,
                ));
            }
            if depth + 1 > MAX_TREE_DEPTH {
                return Err(Error::limit(LimitKind::Depth, MAX_TREE_DEPTH as u64));
            }
            let path = child.path();
            let metadata = checked_metadata(&path, control)?;
            let relative = path
                .strip_prefix(&canonical)
                .map_err(|_| Error::InvalidArchive("树路径超出根目录"))?;
            let name = relative
                .components()
                .map(|part| {
                    part.as_os_str()
                        .to_str()
                        .ok_or(Error::InvalidArchive("树路径不是 UTF-8"))
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            if !paths::safe_entry(&name) {
                return Err(Error::InvalidArchive("树相对路径不安全"));
            }
            let is_directory = metadata.is_dir();
            let size = if is_directory { 0 } else { metadata.len() };
            total = total
                .checked_add(size)
                .ok_or(Error::limit(LimitKind::FileBytes, MAX_FILE_BYTES))?;
            if total > MAX_FILE_BYTES {
                return Err(Error::limit(LimitKind::FileBytes, MAX_FILE_BYTES));
            }
            entries.push(ArchiveEntry {
                name: if is_directory {
                    format!("{name}/")
                } else {
                    name
                },
                size,
                compressed_size: size,
                directory: is_directory,
            });
            if is_directory {
                pending.push((path, depth + 1));
            }
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    control.check()?;
    Ok(TreeSnapshot {
        root: canonical,
        profile,
        directory: Directory {
            entries,
            declared_size: total,
        },
    })
}

pub fn pack(
    snapshot: &TreeSnapshot,
    destination: &mut File,
    control: &Control<'_>,
) -> Result<PackedTree> {
    super::packing::pack(snapshot, destination, control)
}
