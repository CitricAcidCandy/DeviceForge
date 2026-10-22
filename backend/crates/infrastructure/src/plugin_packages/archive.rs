//! 有界归档展开，只创建本次暂存目录内的普通文件。
use super::paths;
use apk_domain::{Error, Result, plugin_packages::PackageFormat};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

const FILE_LIMIT: u64 = 64 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 256 * 1024 * 1024;

struct Extractor<'a> {
    root: &'a Path,
    paths: HashSet<String>,
    total: u64,
    entries: usize,
    npm_prefix: bool,
    file_limit: u64,
    total_limit: u64,
    entry_limit: usize,
}
impl Extractor<'_> {
    fn entry(
        &mut self,
        name: &str,
        directory: bool,
        size: u64,
        reader: &mut impl Read,
        executable: bool,
    ) -> Result<()> {
        self.entries += 1;
        if self.entries > self.entry_limit {
            return Err(Error::TooLarge);
        }
        let name = name.trim_end_matches('/');
        if self.npm_prefix && name == "package" && directory {
            return Ok(());
        }
        let name = if self.npm_prefix {
            name.strip_prefix("package/")
                .ok_or_else(|| Error::Invalid("TGZ 必须使用 npm package 根目录".into()))?
        } else {
            name
        };
        // 完整发布允许工具自身的点目录；旧便携上传继续沿用原有严格路径规则。
        let relative = if self.entry_limit > 4096 {
            apk_domain::plugin_installations::validate_release_path(name)?;
            std::path::PathBuf::from(name)
        } else {
            paths::relative(name)?
        };
        // Windows 大小写与别名不能产生两个相同目的文件。
        if !self.paths.insert(name.to_lowercase()) {
            return Err(Error::Invalid("归档包含重复路径".into()));
        }
        if size > self.file_limit
            || self
                .total
                .checked_add(size)
                .is_none_or(|total| total > self.total_limit)
        {
            return Err(Error::TooLarge);
        }
        self.total += size;
        let path = self.root.join(relative);
        if directory {
            fs::create_dir_all(path).map_err(|_| Error::Invalid("归档目录与文件冲突".into()))?;
            return Ok(());
        }
        fs::create_dir_all(path.parent().expect("文件位于暂存目录"))
            .map_err(|_| Error::Invalid("归档目录与文件冲突".into()))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| Error::Invalid("归档文件冲突或不可写".into()))?;
        let copied = std::io::copy(&mut reader.take(self.file_limit + 1), &mut file)
            .map_err(|_| Error::Invalid("归档内容损坏".into()))?;
        if copied != size || copied > self.file_limit {
            return Err(Error::Invalid("归档文件大小与声明不符".into()));
        }
        file.flush()
            .map_err(|_| Error::Storage("暂存文件刷新失败".into()))?;
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .map_err(|_| Error::Storage("入口权限设置失败".into()))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        Ok(())
    }
}

pub fn extract(input: &Path, root: &Path, format: PackageFormat) -> Result<()> {
    extract_mode(
        input,
        root,
        format,
        matches!(format, PackageFormat::Tgz),
        FILE_LIMIT,
        TOTAL_LIMIT,
        4096,
    )
}

/// 发布资源使用普通归档根，不要求 npm package 前缀；仍复用逐条边界检查。
pub(crate) fn extract_release(input: &Path, root: &Path, format: PackageFormat) -> Result<()> {
    extract_mode(
        input,
        root,
        format,
        false,
        4 * 1024 * 1024 * 1024,
        8 * 1024 * 1024 * 1024,
        32768,
    )
}

pub(crate) fn extract_release_component(
    input: &Path,
    root: &Path,
    format: PackageFormat,
) -> Result<()> {
    extract_mode(
        input,
        root,
        format,
        matches!(format, PackageFormat::Tgz),
        2 * 1024 * 1024 * 1024,
        8 * 1024 * 1024 * 1024,
        32768,
    )
}

fn extract_mode(
    input: &Path,
    root: &Path,
    format: PackageFormat,
    npm_prefix: bool,
    file_limit: u64,
    total_limit: u64,
    entry_limit: usize,
) -> Result<()> {
    let mut target = Extractor {
        root,
        paths: HashSet::new(),
        total: 0,
        entries: 0,
        npm_prefix,
        file_limit,
        total_limit,
        entry_limit,
    };
    let file = File::open(input).map_err(|_| Error::Storage("暂存归档读取失败".into()))?;
    match format {
        PackageFormat::Zip => {
            let mut archive =
                zip::ZipArchive::new(file).map_err(|_| Error::Invalid("ZIP 格式无效".into()))?;
            if archive.len() > entry_limit {
                return Err(Error::TooLarge);
            }
            for index in 0..archive.len() {
                let mut entry = archive
                    .by_index(index)
                    .map_err(|_| Error::Invalid("ZIP 条目无效".into()))?;
                let mode = entry.unix_mode().unwrap_or_default();
                let kind = mode & 0o170000;
                if ![0, 0o100000, 0o040000].contains(&kind) {
                    return Err(Error::Invalid("归档不得包含链接或特殊文件".into()));
                }
                let name = entry.name().to_owned();
                let size = entry.size();
                let directory = entry.is_dir();
                target.entry(&name, directory, size, &mut entry, mode & 0o111 != 0)?;
            }
        }
        PackageFormat::Tgz => {
            // 将解压出的 TAR 字节也设上限，扩展头或尾部填充不能绕开文件总量。
            let gzip = flate2::read::MultiGzDecoder::new(file);
            let mut limited = gzip.take(total_limit + 16 * 1024 * 1024 + 1);
            {
                let mut archive = tar::Archive::new(&mut limited);
                let mut pending_path = None;
                let mut pending_size = None;
                // 原始模式先校验扩展头大小，避免解析库为长路径/PAX 分配巨大缓冲。
                for (count, entry) in archive
                    .entries()
                    .map_err(|_| Error::Invalid("TGZ 格式无效".into()))?
                    .raw(true)
                    .enumerate()
                {
                    if count >= entry_limit {
                        return Err(Error::TooLarge);
                    }
                    let mut entry = entry.map_err(|_| Error::Invalid("TAR 条目无效".into()))?;
                    let kind = entry.header().entry_type();
                    if [b'L', b'x', b'g'].contains(&kind.as_byte()) {
                        if entry.size() > 4096 {
                            return Err(Error::TooLarge);
                        }
                        let mut bytes = Vec::new();
                        entry
                            .read_to_end(&mut bytes)
                            .map_err(|_| Error::Invalid("TAR 扩展头损坏".into()))?;
                        if kind.as_byte() == b'L' {
                            let path = std::str::from_utf8(&bytes)
                                .map_err(|_| Error::Invalid("TAR 长路径必须为 UTF-8".into()))?
                                .trim_end_matches(['\0', '\n'])
                                .to_owned();
                            paths::relative(&path)?;
                            pending_path = Some(path);
                        } else {
                            for (key, value) in pax(&bytes)? {
                                match key {
                                    "path" if kind.as_byte() == b'x' => {
                                        paths::relative(value)?;
                                        pending_path = Some(value.to_owned());
                                    }
                                    "size" if kind.as_byte() == b'x' => {
                                        pending_size =
                                            Some(value.parse::<u64>().map_err(|_| {
                                                Error::Invalid("TAR 大小扩展无效".into())
                                            })?);
                                    }
                                    "path" | "size" | "linkpath" => {
                                        return Err(Error::Invalid(
                                            "TAR 全局路径或链接扩展不受支持".into(),
                                        ));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        continue;
                    }
                    if !kind.is_file() && !kind.is_dir() {
                        return Err(Error::Invalid("TAR 不接受链接或特殊条目".into()));
                    }
                    let name = match pending_path.take() {
                        Some(path) => path,
                        None => entry
                            .path()
                            .map_err(|_| Error::Invalid("TAR 路径无效".into()))?
                            .to_str()
                            .ok_or_else(|| Error::Invalid("归档路径必须为 UTF-8".into()))?
                            .to_owned(),
                    };
                    let size = entry.size();
                    let executable = entry.header().mode().unwrap_or_default() & 0o111 != 0;
                    if pending_size.take().is_some_and(|extended| extended != size) {
                        return Err(Error::Invalid("TAR 扩展大小与头部不一致".into()));
                    }
                    target.entry(&name, kind.is_dir(), size, &mut entry, executable)?;
                }
                if pending_path.is_some() || pending_size.is_some() {
                    return Err(Error::Invalid("TAR 扩展头没有对应文件".into()));
                }
            }
            std::io::copy(&mut limited, &mut std::io::sink())
                .map_err(|_| Error::Invalid("TGZ 内容损坏或校验失败".into()))?;
            if limited.limit() == 0 {
                return Err(Error::TooLarge);
            }
        }
    }
    Ok(())
}

fn pax(mut bytes: &[u8]) -> Result<Vec<(&str, &str)>> {
    let mut fields = Vec::new();
    while !bytes.is_empty() {
        let space = bytes
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(|| Error::Invalid("PAX 长度字段无效".into()))?;
        let length = std::str::from_utf8(&bytes[..space])
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|length| *length > space + 2 && *length <= bytes.len())
            .ok_or_else(|| Error::Invalid("PAX 记录大小无效".into()))?;
        let record = &bytes[space + 1..length];
        if record.last() != Some(&b'\n') {
            return Err(Error::Invalid("PAX 记录不完整".into()));
        }
        let record = std::str::from_utf8(&record[..record.len() - 1])
            .map_err(|_| Error::Invalid("PAX 记录必须为 UTF-8".into()))?;
        fields.push(
            record
                .split_once('=')
                .ok_or_else(|| Error::Invalid("PAX 记录字段无效".into()))?,
        );
        bytes = &bytes[length..];
    }
    Ok(fields)
}
