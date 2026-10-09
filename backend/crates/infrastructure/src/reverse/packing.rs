use crate::artifact_files::LIMIT;
use apk_domain::{Error, Result};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;
use zip::{ZipWriter, write::SimpleFileOptions};
fn storage(e: impl std::fmt::Display) -> Error {
    Error::Storage(e.to_string())
}

struct LimitedFile {
    file: File,
    position: u64,
}
impl Write for LimitedFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.position.saturating_add(bytes.len() as u64) > LIMIT {
            return Err(std::io::Error::other("反编译 ZIP 超过 64 MiB"));
        }
        let size = self.file.write(bytes)?;
        self.position += size as u64;
        Ok(size)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
impl Seek for LimitedFile {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.position = self.file.seek(position)?;
        Ok(self.position)
    }
}
fn collect(
    root: &Path,
    cancel: &CancellationToken,
    required: bool,
) -> Result<Vec<(String, PathBuf, u64)>> {
    let canonical = fs::canonicalize(root).map_err(storage)?;
    if fs::symlink_metadata(root)
        .map_err(storage)?
        .file_type()
        .is_symlink()
    {
        return Err(Error::Invalid("反编译目录不允许符号链接".into()));
    }
    let mut pending = vec![(canonical.clone(), 0usize)];
    let mut files = Vec::new();
    let mut count = 0usize;
    let mut total = 0u64;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 128 {
            return Err(Error::TooLarge);
        }
        for entry in fs::read_dir(&directory).map_err(storage)? {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            count += 1;
            if count > 10_000 {
                return Err(Error::TooLarge);
            }
            let entry = entry.map_err(storage)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(storage)?;
            if metadata.file_type().is_symlink()
                || fs::canonicalize(&path).map_err(storage)? != path
            {
                return Err(Error::Invalid(
                    "反编译输出不允许符号链接或重解析路径".into(),
                ));
            }
            if metadata.is_dir() {
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                let name = path
                    .strip_prefix(&canonical)
                    .map_err(storage)?
                    .to_str()
                    .ok_or_else(|| Error::Invalid("反编译条目名称必须为 UTF-8".into()))?
                    .replace('\\', "/");
                if !crate::artifacts::validation::safe_entry(&name) {
                    return Err(Error::Invalid("反编译条目名称无效".into()));
                }
                total = total.checked_add(metadata.len()).ok_or(Error::TooLarge)?;
                if total > LIMIT {
                    return Err(Error::TooLarge);
                }
                files.push((name, path, metadata.len()));
            } else {
                return Err(Error::Invalid("反编译输出包含非普通文件".into()));
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    for required_name in ["apktool.yml", "AndroidManifest.xml"] {
        if required
            && !files
                .iter()
                .any(|(name, _, size)| name == required_name && *size > 0)
        {
            return Err(Error::Dependency(format!(
                "反编译未生成有效的 {required_name}"
            )));
        }
    }
    Ok(files)
}
pub(super) fn pack(
    root: &Path,
    destination: &Path,
    cancel: &CancellationToken,
) -> Result<(usize, u64)> {
    let files = collect(root, cancel, true)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(storage)?;
    let mut zip = ZipWriter::new(LimitedFile { file, position: 0 });
    let mut total = 0;
    for (name, path, expected) in &files {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(storage)?;
        let mut file = File::open(path).map_err(storage)?;
        let mut buffer = [0; 64 * 1024];
        let mut size = 0u64;
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let count = file.read(&mut buffer).map_err(storage)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > *expected {
                return Err(Error::Conflict("反编译输出在打包期间变化".into()));
            }
            zip.write_all(&buffer[..count]).map_err(storage)?;
        }
        if size != *expected {
            return Err(Error::Conflict("反编译输出在打包期间变化".into()));
        }
        total += size;
    }
    let output = zip.finish().map_err(storage)?;
    output.file.sync_all().map_err(storage)?;
    Ok((files.len(), total))
}

pub(super) fn check(root: &Path, cancel: &CancellationToken) -> Result<()> {
    collect(root, cancel, false).map(|_| ())
}
