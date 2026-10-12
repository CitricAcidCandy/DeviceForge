//! 缓存只持有来源专属短锁，不发起网络请求，也不取得模块锁。
use crate::{
    budget::Budget,
    config::{Config, MANIFEST_LIMIT},
    error::{Error, Result},
    manifest::Manifest,
    storage,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const ENVELOPE_LIMIT: u64 = 2 * MANIFEST_LIMIT;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    source_sha256: String,
    manifest_sha256: String,
    manifest: Manifest,
}

pub(crate) fn source_digest(url: &str) -> Result<String> {
    let normalized = reqwest::Url::parse(url).map_err(|_| Error::Invalid("清单下载地址无效"))?;
    Ok(format!(
        "{:x}",
        Sha256::digest(normalized.as_str().as_bytes())
    ))
}

pub(crate) fn canonical(manifest: &Manifest) -> Result<Vec<u8>> {
    // 固定结构字段声明顺序、默认字段与数组顺序；不按版本号或原始JSON空白计算身份。
    let bytes = serde_json::to_vec(manifest).map_err(|_| Error::Invalid("工具清单规范化失败"))?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}

pub(crate) fn digest(manifest: &Manifest) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(canonical(manifest)?)))
}

pub(crate) struct CacheLock {
    _file: File,
    directory: PathBuf,
    source_sha256: String,
}

impl CacheLock {
    pub(crate) fn acquire(
        config: &Config,
        source_sha256: &str,
        create: bool,
        budget: &Budget,
    ) -> Result<Option<Self>> {
        budget.check()?;
        if source_sha256.len() != 64 || !source_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::Invalid("清单缓存来源摘要无效"));
        }
        let directory = config.root.join(".manifest-cache");
        if create {
            storage::directory(&directory)?;
        }
        let Some(metadata) = storage::metadata(&directory, "检查清单缓存目录失败")?
        else {
            budget.check()?;
            return Ok(None);
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::Invalid("清单缓存目录必须是普通目录"));
        }
        // Windows原子替换的目标与临时目录均使用同一规范长路径。
        let directory =
            fs::canonicalize(directory).map_err(|_| Error::Io("解析清单缓存目录失败"))?;
        let path = directory.join(format!("{source_sha256}.lock"));
        if storage::metadata(&path, "检查清单缓存锁失败")?
            .is_some_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(Error::Invalid("清单缓存锁必须是普通文件"));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| Error::Io("打开清单缓存锁失败"))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                return Err(Error::CacheBusy);
            }
            Err(_) => return Err(Error::Io("获取清单缓存锁失败")),
        }
        budget.check()?;
        let lock = Self {
            _file: file,
            directory,
            source_sha256: source_sha256.into(),
        };
        if storage::metadata(&lock.pending(), "检查清单缓存暂存失败")?.is_some() {
            return Err(Error::Cleanup);
        }
        Ok(Some(lock))
    }

    fn snapshot(&self) -> PathBuf {
        self.directory.join(format!("{}.json", self.source_sha256))
    }

    fn pending(&self) -> PathBuf {
        self.directory
            .join(format!("{}.pending", self.source_sha256))
    }

    fn regular_snapshot(&self) -> Result<bool> {
        let Some(metadata) = storage::metadata(&self.snapshot(), "检查清单缓存快照失败")?
        else {
            return Ok(false);
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::Invalid("清单缓存快照必须是普通文件"));
        }
        Ok(true)
    }

    fn read(&self, config: &Config, budget: &Budget) -> Result<Option<Manifest>> {
        budget.check()?;
        if !self.regular_snapshot()? {
            budget.check()?;
            return Ok(None);
        }
        let bytes = crate::config::read_bounded(&self.snapshot(), ENVELOPE_LIMIT, budget)?;
        let envelope: Envelope =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("清单缓存封装损坏"))?;
        if envelope.schema_version != 1 || envelope.source_sha256 != self.source_sha256 {
            return Err(Error::Invalid("清单缓存版本或来源身份不符"));
        }
        envelope.manifest.validate(config)?;
        if digest(&envelope.manifest)? != envelope.manifest_sha256 {
            return Err(Error::Invalid("清单缓存快照摘要不符"));
        }
        budget.check()?;
        Ok(Some(envelope.manifest))
    }

    fn write(&self, manifest: &Manifest, budget: &Budget) -> Result<()> {
        self.write_checked(manifest, &|| budget.check())
    }

    fn write_checked(&self, manifest: &Manifest, check: &dyn Fn() -> Result<()>) -> Result<()> {
        check()?;
        self.regular_snapshot()?;
        let envelope = Envelope {
            schema_version: 1,
            source_sha256: self.source_sha256.clone(),
            manifest_sha256: digest(manifest)?,
            manifest: manifest.clone(),
        };
        let bytes =
            serde_json::to_vec(&envelope).map_err(|_| Error::Invalid("清单缓存封装序列化失败"))?;
        if bytes.len() as u64 > ENVELOPE_LIMIT {
            return Err(Error::TooLarge);
        }
        check()?;
        let pending = self.pending();
        match fs::create_dir(&pending) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::Cleanup);
            }
            Err(_) => return Err(Error::Io("创建清单缓存暂存失败")),
        }
        let outcome = (|| {
            let temporary = tempfile::NamedTempFile::new_in(&pending)
                .map_err(|_| Error::Io("创建清单缓存临时文件失败"))?;
            commit(temporary, &self.snapshot(), &bytes, check)
        })();
        // 清理不依赖已撤销的业务预算；不能以临时文件Drop替代清理确认。
        fs::remove_dir(&pending).map_err(|_| Error::Cleanup)?;
        outcome
    }
}

fn commit(
    mut temporary: tempfile::NamedTempFile,
    target: &Path,
    bytes: &[u8],
    check: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let written = (|| {
        check()?;
        let file = temporary.as_file_mut();
        write_bytes(file, bytes, &|file| file.sync_all())?;
        check()
    })();
    if let Err(error) = written {
        temporary.close().map_err(|_| Error::Cleanup)?;
        return Err(error);
    }
    match temporary.persist(target) {
        Ok(file) => drop(file),
        Err(error) => {
            error.file.close().map_err(|_| Error::Cleanup)?;
            return Err(Error::Io("清单缓存提交失败，保留原快照"));
        }
    }
    check()
}

fn write_bytes<Writer: Write>(
    writer: &mut Writer,
    bytes: &[u8],
    sync: &dyn Fn(&Writer) -> std::io::Result<()>,
) -> Result<()> {
    writer
        .write_all(bytes)
        .map_err(|_| Error::Io("写入清单缓存失败"))?;
    writer.flush().map_err(|_| Error::Io("刷新清单缓存失败"))?;
    sync(writer).map_err(|_| Error::Io("持久化清单缓存失败"))
}

pub(crate) fn read(
    config: &Config,
    source_sha256: &str,
    budget: &Budget,
) -> Result<Option<Manifest>> {
    let Some(lock) = CacheLock::acquire(config, source_sha256, false, budget)? else {
        return Ok(None);
    };
    lock.read(config, budget)
}

pub(crate) fn write(
    config: &Config,
    source_sha256: &str,
    manifest: &Manifest,
    budget: &Budget,
) -> Result<()> {
    let lock = CacheLock::acquire(config, source_sha256, true, budget)?
        .ok_or(Error::Io("清单缓存目录不存在"))?;
    lock.read(config, budget)?;
    lock.write(manifest, budget)
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
