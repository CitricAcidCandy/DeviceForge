//! 公共核心的文件接缝与全目录去重；不复制 ZIP/XML 算法。
use crate::{Error, Result};
use deviceforge_android_package_core::{
    ArchiveProfile, Control,
    archive::{Archive, tree},
};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    path::Path,
};

pub(super) const LIMIT: u64 = 64 * 1024 * 1024;

pub(super) fn archive(path: &Path, control: &Control<'_>) -> Result<Archive> {
    control.check()?;
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Io("读取包文件属性失败"))?;
    regular(&metadata)?;
    control.check()?;
    let file = File::open(path).map_err(|_| Error::Io("读取包文件失败"))?;
    control.check()?;
    regular(
        &file
            .metadata()
            .map_err(|_| Error::Io("读取包文件属性失败"))?,
    )?;
    let archive = Archive::open(file, ArchiveProfile::Structure, control)?;
    let mut names = BTreeSet::new();
    for entry in archive.directory().entries() {
        control.check()?;
        if !names.insert(entry.name.as_str()) {
            return Err(Error::Invalid("ZIP 包含重复条目"));
        }
    }
    Ok(archive)
}

fn regular(metadata: &Metadata) -> Result<()> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || reparse(metadata) {
        return Err(Error::Invalid("包文件必须为普通文件"));
    }
    if metadata.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(())
}

#[cfg(windows)]
fn reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse(_metadata: &Metadata) -> bool {
    false
}

pub(super) fn create(path: &Path, control: &Control<'_>) -> Result<File> {
    control.check()?;
    OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::Io("创建私有输出文件失败"))
}

pub(super) fn pack(
    root: &Path,
    output: &Path,
    profile: deviceforge_android_package_core::TreeProfile,
    control: &Control<'_>,
) -> Result<deviceforge_android_package_core::PackedTree> {
    let snapshot = tree::scan(root, profile, control)?;
    let mut file = create(output, control)?;
    let packed = tree::pack(&snapshot, &mut file, control)?;
    control.check()?;
    file.sync_all().map_err(|_| Error::Io("同步打包产物失败"))?;
    control.check()?;
    Ok(packed)
}

pub(super) fn failed_diagnostic(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "failure",
        "failed",
        "error",
        "unable",
        "cannot",
        "offline",
        "unauthorized",
        "no devices",
        "incompatible",
    ]
    .iter()
    .any(|word| text.contains(word))
}
