//! 下载产物只解包到调用独占暂存目录，拒绝穿越、链接、重复路径与解压炸弹。
use super::{check, files};
use apk_domain::{
    Error, Result,
    plugin_dependencies::{ArchiveFormat, DependencySource},
};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

struct Budget {
    bytes: u64,
    count: usize,
    paths: BTreeSet<String>,
}

fn copy(
    source: &mut dyn Read,
    destination: &Path,
    expected: u64,
    budget: &mut Budget,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<()> {
    if expected > 2 * 1024 * 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(files::io)?;
    let mut buffer = [0u8; 65536];
    let mut length = 0u64;
    loop {
        check(cancel, deadline)?;
        let count = source.read(&mut buffer).map_err(files::io)?;
        if count == 0 {
            break;
        }
        length = length
            .checked_add(count as u64)
            .filter(|size| *size <= expected)
            .ok_or(Error::TooLarge)?;
        budget.bytes = budget
            .bytes
            .checked_add(count as u64)
            .filter(|size| *size <= 8 * 1024 * 1024 * 1024)
            .ok_or(Error::TooLarge)?;
        output.write_all(&buffer[..count]).map_err(files::io)?;
    }
    if length != expected {
        return Err(Error::Invalid("解压文件长度不匹配".into()));
    }
    output.sync_all().map_err(files::io)
}

fn destination(
    root: &Path,
    name: &str,
    directory: bool,
    budget: &mut Budget,
) -> Result<std::path::PathBuf> {
    budget.count += 1;
    if budget.count > 32768
        || !budget
            .paths
            .insert(name.trim_end_matches('/').to_ascii_lowercase())
    {
        return Err(Error::Invalid("归档路径重复或数量超限".into()));
    }
    let relative = files::relative(name.trim_end_matches('/'))?;
    if relative.components().count() > 32 || relative == Path::new("inventory.json") {
        return Err(Error::Invalid("归档含保留路径或层级超限".into()));
    }
    let path = root.join(relative);
    if directory {
        files::directory(&path)?;
    } else {
        files::directory(
            path.parent()
                .ok_or_else(|| Error::Invalid("归档入口没有父目录".into()))?,
        )?;
    }
    Ok(path)
}

pub(super) fn extract(
    archive: &Path,
    root: &Path,
    source: &DependencySource,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<()> {
    check(cancel, deadline)?;
    files::directory(root)?;
    let mut budget = Budget {
        bytes: 0,
        count: 0,
        paths: BTreeSet::new(),
    };
    match source.format {
        ArchiveFormat::File => {
            let names: BTreeSet<_> = source.entries.values().collect();
            if names.len() != 1 {
                return Err(Error::Invalid(
                    "单文件来源必须将所有入口映射到同一文件".into(),
                ));
            }
            let name = names
                .first()
                .ok_or_else(|| Error::Invalid("单文件来源缺少入口".into()))?;
            let output = destination(root, name, false, &mut budget)?;
            copy(
                &mut fs::File::open(archive).map_err(files::io)?,
                &output,
                source.size,
                &mut budget,
                cancel,
                deadline,
            )?;
            executable(&output, 0o755)?;
        }
        ArchiveFormat::Zip => {
            let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(files::io)?)
                .map_err(|_| Error::Invalid("依赖 ZIP 无效".into()))?;
            if zip.len() > 32768 {
                return Err(Error::TooLarge);
            }
            for index in 0..zip.len() {
                check(cancel, deadline)?;
                let mut entry = zip
                    .by_index(index)
                    .map_err(|_| Error::Invalid("ZIP 成员无效".into()))?;
                let directory = entry.is_dir();
                let mode = entry
                    .unix_mode()
                    .unwrap_or(if directory { 0o40755 } else { 0o100755 });
                if !matches!(mode & 0o170000, 0 | 0o040000 | 0o100000) {
                    return Err(Error::Invalid("ZIP 不允许链接或特殊文件".into()));
                }
                let output = destination(root, entry.name(), directory, &mut budget)?;
                if !directory {
                    let size = entry.size();
                    copy(&mut entry, &output, size, &mut budget, cancel, deadline)?;
                    executable(&output, mode)?;
                }
            }
        }
        ArchiveFormat::Tgz => {
            let gzip = flate2::read::GzDecoder::new(fs::File::open(archive).map_err(files::io)?);
            let mut archive = tar::Archive::new(gzip);
            for entry in archive.entries().map_err(files::io)? {
                check(cancel, deadline)?;
                let mut entry = entry.map_err(files::io)?;
                let kind = entry.header().entry_type();
                if !kind.is_dir() && !kind.is_file() {
                    return Err(Error::Invalid("TGZ 不允许链接或特殊文件".into()));
                }
                let name = entry
                    .path()
                    .map_err(files::io)?
                    .to_str()
                    .ok_or_else(|| Error::Invalid("TGZ 路径不是 UTF-8".into()))?
                    .to_owned();
                let output = destination(root, &name, kind.is_dir(), &mut budget)?;
                if kind.is_file() {
                    let size = entry.size();
                    let mode = entry.header().mode().map_err(files::io)?;
                    copy(&mut entry, &output, size, &mut budget, cancel, deadline)?;
                    executable(&output, mode)?;
                }
            }
        }
    }
    for relative in source.entries.values() {
        let entry = files::file(&root.join(files::relative(relative)?))?;
        if !entry.starts_with(root) {
            return Err(Error::Invalid("解包入口越界".into()));
        }
    }
    check(cancel, deadline)
}

fn executable(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777)).map_err(files::io)?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
