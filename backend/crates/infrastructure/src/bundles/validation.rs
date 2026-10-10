use crate::artifact_files::LIMIT;
use apk_domain::{Error, Result, bundles::BuildMode};
use deviceforge_android_package_core::{
    ArchiveProfile, Control, Error as CoreError, LimitKind, archive::Archive,
};
use std::{fs::File, path::Path};
use tokio_util::sync::CancellationToken;

pub(crate) fn check(path: &Path, mode: BuildMode, cancel: &CancellationToken) -> Result<usize> {
    controlled(path, mode, &Control::new(None, &|| cancel.is_cancelled()))
}

fn mapped(error: CoreError) -> Error {
    match error {
        CoreError::Cancelled => Error::Cancelled,
        CoreError::Timeout => Error::Timeout,
        CoreError::LimitExceeded {
            kind: LimitKind::Entries,
            ..
        } => Error::Invalid("压缩包条目超过 10000".into()),
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        CoreError::Io { source, .. } => Error::Storage(source.to_string()),
        CoreError::InvalidArchive(message) => Error::Invalid(
            match message {
                "APKS 外层有重复成员" => "APKS 包含重名条目",
                "APK 成员缺少 ZIP 标识" => "APKS 内 APK 缺少 ZIP 标识",
                "APKS 必须有非空 toc.pb 和 APK" => "APKS 必须包含非空 toc.pb 和 APK 条目",
                "Universal 模式需要且仅能有 universal.apk" => {
                    "通用模式必须包含唯一 universal.apk"
                }
                "APKS 成员实际长度超过声明" | "APKS 成员没有完整读取" => {
                    "APKS 条目长度不一致"
                }
                _ => "APKS 条目解压或 CRC 校验失败",
            }
            .into(),
        ),
        _ => Error::Invalid("APKS 条目无效".into()),
    }
}

fn structure_error(error: CoreError) -> Error {
    match error {
        CoreError::LimitExceeded {
            kind: LimitKind::ExpandedBytes,
            ..
        } => Error::Invalid("压缩包声明解压体积超过 2 GiB".into()),
        other => mapped(other),
    }
}

pub(crate) fn controlled(path: &Path, mode: BuildMode, control: &Control<'_>) -> Result<usize> {
    control.check().map_err(mapped)?;
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| Error::Dependency("构建工具没有生成 APKS 文件".into()))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(Error::Invalid("构建输出必须为普通文件".into()));
    }
    if meta.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    control.check().map_err(mapped)?;
    let file = File::open(path).map_err(|error| Error::Storage(error.to_string()))?;
    let mut archive =
        Archive::open(file, ArchiveProfile::Structure, control).map_err(structure_error)?;
    let mode = match mode {
        BuildMode::Default => deviceforge_android_package_core::BuildMode::Default,
        BuildMode::Universal => deviceforge_android_package_core::BuildMode::Universal,
    };
    let summary =
        deviceforge_android_package_core::android::validate_apks(&mut archive, mode, control)
            .map_err(mapped)?;
    Ok(summary.apk_count)
}
