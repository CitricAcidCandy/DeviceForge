use crate::{Error, Result, input::FILE_LIMIT};
use apk_plugin_sdk::ArtifactInput;
use deviceforge_android_package_core::Control;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path},
};

#[cfg(windows)]
fn reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse(_: &Metadata) -> bool {
    false
}

fn regular(path: &Path, control: &Control<'_>) -> Result<Metadata> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::Invalid("授权产物路径须为绝对路径"));
    }
    let mut found = None;
    for ancestor in path.ancestors() {
        control.check()?;
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| Error::Io)?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (ancestor == path && !metadata.is_file())
            || (ancestor != path && !metadata.is_dir())
        {
            return Err(Error::Invalid("授权产物路径经过链接或非普通文件"));
        }
        if ancestor == path {
            found = Some(metadata);
        }
    }
    found.ok_or(Error::Invalid("授权产物路径无效"))
}

pub(crate) fn read(artifact: &ArtifactInput, control: &Control<'_>) -> Result<Vec<u8>> {
    control.check()?;
    let path = Path::new(&artifact.path);
    let metadata = regular(path, control)?;
    if metadata.len() != artifact.size || metadata.len() > FILE_LIMIT {
        return Err(Error::Invalid("授权DEX文件长度不一致"));
    }
    let mut file = File::open(path).map_err(|_| Error::Io)?;
    let opened = file.metadata().map_err(|_| Error::Io)?;
    if !opened.is_file() || opened.len() != artifact.size {
        return Err(Error::Invalid("已打开DEX文件类型或长度不一致"));
    }
    let mut bytes = Vec::with_capacity(artifact.size as usize);
    let mut digest = Sha256::new();
    let mut block = [0u8; 65_536];
    loop {
        control.check()?;
        let size = file.read(&mut block).map_err(|_| Error::Io)?;
        control.check()?;
        if size == 0 {
            break;
        }
        if bytes.len() as u64 + size as u64 > artifact.size {
            return Err(Error::Invalid("DEX读取期间长度增长"));
        }
        digest.update(&block[..size]);
        bytes.extend_from_slice(&block[..size]);
    }
    if bytes.len() as u64 != artifact.size
        || file.metadata().map_err(|_| Error::Io)?.len() != artifact.size
        || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&artifact.sha256)
    {
        return Err(Error::Invalid("DEX输入长度或SHA256与宿主不一致"));
    }
    control.check()?;
    Ok(bytes)
}
