//! 反编译树规则与打包由公共核心承担，薄层保留场景错误。
use apk_domain::{Error, Result};
use deviceforge_android_package_core::{Control, Error as CoreError, TreeProfile, archive::tree};
use std::{fs::OpenOptions, path::Path};
#[cfg(test)]
use tokio_util::sync::CancellationToken;
pub(super) fn mapped(error: CoreError) -> Error {
    match error {
        CoreError::Cancelled => Error::Cancelled,
        CoreError::Timeout => Error::Timeout,
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        CoreError::SourceChanged => Error::Conflict("反编译输出在打包期间变化".into()),
        CoreError::Io { source, .. } => Error::Storage(source.to_string()),
        CoreError::InvalidArgument(message) | CoreError::InvalidArchive(message) => {
            Error::Invalid(message.into())
        }
        _ => Error::Invalid("反编译输出无效".into()),
    }
}
pub(super) fn check_controlled(root: &Path, control: &Control<'_>) -> Result<()> {
    tree::scan(root, TreeProfile::Reverse, control)
        .map(|_| ())
        .map_err(mapped)
}
pub(super) fn pack_controlled(
    root: &Path,
    destination: &Path,
    control: &Control<'_>,
) -> Result<(usize, u64)> {
    let snapshot = tree::scan(root, TreeProfile::Reverse, control).map_err(mapped)?;
    for required in ["apktool.yml", "AndroidManifest.xml"] {
        if !snapshot
            .directory()
            .entries()
            .iter()
            .any(|entry| entry.name == required && !entry.directory && entry.size > 0)
        {
            return Err(Error::Dependency(format!("反编译未生成有效的 {required}")));
        }
    }
    control.check().map_err(mapped)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| Error::Storage(error.to_string()))?;
    let summary = tree::pack(&snapshot, &mut file, control).map_err(mapped)?;
    Ok((summary.files, summary.unpacked_size))
}
#[cfg(test)]
pub(super) fn pack(
    root: &Path,
    destination: &Path,
    cancel: &CancellationToken,
) -> Result<(usize, u64)> {
    pack_controlled(
        root,
        destination,
        &Control::new(None, &|| cancel.is_cancelled()),
    )
}
#[cfg(test)]
pub(super) fn check(root: &Path, cancel: &CancellationToken) -> Result<()> {
    check_controlled(root, &Control::new(None, &|| cancel.is_cancelled()))
}
