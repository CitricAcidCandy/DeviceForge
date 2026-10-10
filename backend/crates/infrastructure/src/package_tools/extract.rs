//! 精确归档复制与产物发布编排，归档机制由公共核心承担。
use super::{AndroidPackageTools, TIMEOUT};
use crate::{
    artifact_files::{LIMIT, materialize_until},
    execution_deadline,
};
use apk_domain::{Error, ExecutionContext, Result, packages::ExtractedApk};
use deviceforge_android_package_core::{
    ArchiveProfile, Error as CoreError, LimitKind,
    archive::{Archive, paths},
};
use futures_util::TryStreamExt;
use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

fn archive_error(error: CoreError) -> Error {
    match error {
        CoreError::Cancelled | CoreError::Timeout => super::control_error(error),
        CoreError::EntryMissing => Error::NotFound("APKS 内不存在指定 APK 条目".into()),
        CoreError::EntryDuplicate => Error::Invalid("APKS 包含同名 APK 条目，无法确定选择".into()),
        CoreError::LimitExceeded {
            kind: LimitKind::Entries,
            ..
        } => Error::Invalid("压缩包条目超过 10000".into()),
        CoreError::LimitExceeded {
            kind: LimitKind::ExpandedBytes,
            ..
        } => Error::Invalid("压缩包声明解压体积超过 2 GiB".into()),
        CoreError::LimitExceeded { .. } => Error::TooLarge,
        CoreError::Io { source, .. } => Error::Storage(source.to_string()),
        _ => Error::Invalid("文件不是有效的 ZIP 容器".into()),
    }
}

pub(super) async fn run(
    tools: &AndroidPackageTools,
    id: &str,
    entry: &str,
    cancel: CancellationToken,
    context: ExecutionContext,
) -> Result<ExtractedApk> {
    let point = context.deadline.map(tokio::time::Instant::from_std);
    execution_deadline::check(&cancel, point)?;
    if entry.len() > 500
        || !entry.to_ascii_lowercase().ends_with(".apk")
        || !paths::safe_entry(entry)
    {
        return Err(Error::Invalid(
            "必须选择 APKS 内不含越界路径的 APK 条目".into(),
        ));
    }
    let input = materialize_until(
        tools.artifacts.as_ref(),
        id,
        &[".apks"],
        cancel.clone(),
        point,
    )
    .await?;
    let _directory = input.directory.clone();
    let destination = input.directory.path().join("extracted.apk");
    let target = destination.clone();
    let name = entry.to_owned();
    let deadline = context
        .deadline
        .or_else(|| Some((tokio::time::Instant::now() + TIMEOUT).into_std()));
    tools
        .workers
        .run(cancel.clone(), deadline, move |control| {
            let _lease = input.directory;
            control.check().map_err(super::control_error)?;
            let file = File::open(input.path).map_err(|error| Error::Storage(error.to_string()))?;
            let mut archive =
                Archive::open(file, ArchiveProfile::Structure, control).map_err(archive_error)?;
            let mut names = BTreeSet::new();
            for member in archive.directory().entries() {
                control.check().map_err(super::control_error)?;
                if !names.insert(member.name.as_str()) {
                    return Err(Error::Invalid("ZIP 包含重复条目或目录数量不匹配".into()));
                }
                if member.name == name && (member.directory || member.size > LIMIT) {
                    return Err(Error::TooLarge);
                }
            }
            drop(names);
            let selected = archive
                .select_exact(&name, control)
                .map_err(archive_error)?;
            control.check().map_err(super::control_error)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|error| Error::Storage(error.to_string()))?;
            selected
                .copy_to(&mut output, LIMIT, control)
                .map_err(|error| match error {
                    CoreError::InvalidArchive(_) => {
                        Error::Invalid("APK 条目解压或 CRC 校验失败".into())
                    }
                    other => archive_error(other),
                })?;
            Ok(())
        })
        .await?;
    let publish = point.unwrap_or_else(|| tokio::time::Instant::now() + TIMEOUT);
    let file = execution_deadline::run(&cancel, Some(publish), async {
        tokio::fs::File::open(destination)
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    })
    .await?;
    let stream = ReaderStream::new(file).map_err(|error| Error::Storage(error.to_string()));
    let artifact = execution_deadline::run(
        &cancel,
        Some(publish),
        tools
            .artifacts
            .put("extracted.apk".into(), Box::pin(stream)),
    )
    .await?;
    Ok(ExtractedApk {
        source_artifact_id: id.into(),
        entry: entry.into(),
        artifact,
    })
}
