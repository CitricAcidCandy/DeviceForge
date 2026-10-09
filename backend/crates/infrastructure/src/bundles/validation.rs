use crate::{artifact_files::LIMIT, artifacts::validation};
use apk_domain::{Error, Result, bundles::BuildMode};
use std::{collections::HashSet, io::Read, path::Path};
use tokio_util::sync::CancellationToken;
const EXPANDED_LIMIT: u64 = 256 * 1024 * 1024;

pub(crate) fn check(path: &Path, mode: BuildMode, cancel: &CancellationToken) -> Result<usize> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| Error::Dependency("构建工具没有生成 APKS 文件".into()))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(Error::Invalid("构建输出必须为普通文件".into()));
    }
    if meta.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    validation::validate_archive(path)?;
    let mut archive = validation::archive(path)?;
    let mut names = HashSet::new();
    let mut total = 0u64;
    let mut apks = 0;
    let mut toc = false;
    let mut universal = false;
    let mut buffer = [0u8; 64 * 1024];
    for index in 0..archive.len() {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|_| Error::Invalid("APKS 条目无效".into()))?;
        if !names.insert(entry.name().to_owned()) {
            return Err(Error::Invalid("APKS 包含重名条目".into()));
        }
        if entry.is_dir() {
            continue;
        }
        let is_apk = entry.name().ends_with(".apk");
        let is_toc = entry.name() == "toc.pb";
        let declared = entry.size();
        total = total.checked_add(declared).ok_or(Error::TooLarge)?;
        if total > EXPANDED_LIMIT {
            return Err(Error::TooLarge);
        }
        let mut read = 0u64;
        let mut header = Vec::with_capacity(4);
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let count = entry
                .read(&mut buffer)
                .map_err(|_| Error::Invalid("APKS 条目解压或 CRC 校验失败".into()))?;
            if count == 0 {
                break;
            }
            read += count as u64;
            if read > declared {
                return Err(Error::Invalid("APKS 条目长度不一致".into()));
            }
            if header.len() < 4 {
                header.extend_from_slice(&buffer[..count.min(4 - header.len())]);
            }
        }
        if read != declared {
            return Err(Error::Invalid("APKS 条目长度不一致".into()));
        }
        if is_apk {
            if header != b"PK\x03\x04" {
                return Err(Error::Invalid("APKS 内 APK 缺少 ZIP 标识".into()));
            }
            apks += 1;
            universal |= entry.name() == "universal.apk";
        }
        toc |= is_toc && read > 0;
    }
    if !toc || apks == 0 {
        return Err(Error::Invalid(
            "APKS 必须包含非空 toc.pb 和 APK 条目".into(),
        ));
    }
    if mode == BuildMode::Universal && (!universal || apks != 1) {
        return Err(Error::Invalid("通用模式必须包含唯一 universal.apk".into()));
    }
    Ok(apks)
}
