//! 宿主和插件共用的不可变工具仓库，不包含网络、宿主状态或具体插件规则。
mod content;
mod index;
#[cfg(test)]
mod index_tests;
mod paths;
mod references;
#[cfg(test)]
mod tests;

pub use index::{ToolIndex, ToolIndexEntry};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("共享工具仓库正在使用")]
    Busy,
    #[error("工具仍被活动版本、上版或调用引用")]
    InUse,
    #[error("共享工具仓库数据无效：{0}")]
    Invalid(&'static str),
    #[error("共享工具仓库超过资源限额")]
    TooLarge,
    #[error("共享工具仓库操作已取消")]
    Cancelled,
    #[error("共享工具仓库操作已超时")]
    Timeout,
    #[error("共享工具仓库文件操作失败")]
    Io(#[source] std::io::Error),
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolKey {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub sha256: String,
}

impl ToolKey {
    pub fn validate(&self) -> Result<()> {
        paths::segment(&self.id)?;
        paths::segment(&self.version)?;
        paths::segment(&self.platform)?;
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(Error::Invalid("摘要必须是小写 SHA-256"));
        }
        Ok(())
    }
    pub fn relative(&self) -> Result<PathBuf> {
        self.validate()?;
        Ok(PathBuf::from(&self.id)
            .join(&self.version)
            .join(&self.platform)
            .join(&self.sha256))
    }
}

#[derive(Clone, Debug)]
pub struct Repository {
    root: PathBuf,
}

/// 调用或准备阶段持有共享锁，任何仓库移除与发布都会明确返回 Busy。
pub struct ReadLease {
    repository: Repository,
    _lock: fs::File,
}

/// 写锁覆盖引用计算、原子发布和删除，调用方不能在检查后绕过该锁删除共享目录。
pub struct WriteGuard {
    repository: Repository,
    _lock: fs::File,
}

impl Repository {
    /// root 就是 tools 根；公共库不读环境变量，也不推断用户主目录。
    pub fn open(root: &Path) -> Result<Self> {
        let root = paths::open_root(root)?;
        paths::create_directory(&root, Path::new(".repository/references"))?;
        Ok(Self { root })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn platform() -> String {
        let os = match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            value => value,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            value => value,
        };
        format!("{os}-{arch}")
    }
    pub fn path(&self, key: &ToolKey) -> Result<PathBuf> {
        Ok(self.root.join(key.relative()?))
    }
    /// 入口由资源描述传入，须落在四层内容目录内，不能包含父目录或其他前缀。
    pub fn key_for_entry(&self, entry: &Path) -> Result<ToolKey> {
        use std::path::Component;
        let relative = entry
            .strip_prefix(&self.root)
            .map_err(|_| Error::Invalid("工具入口不在共享仓库内"))?;
        let parts = relative
            .components()
            .map(|part| match part {
                Component::Normal(value) => {
                    value.to_str().ok_or(Error::Invalid("工具入口不是 UTF-8"))
                }
                _ => Err(Error::Invalid("工具入口越界")),
            })
            .collect::<Result<Vec<_>>>()?;
        if parts.len() < 5 {
            return Err(Error::Invalid("工具入口缺少内容路径"));
        }
        let key = ToolKey {
            id: parts[0].into(),
            version: parts[1].into(),
            platform: parts[2].into(),
            sha256: parts[3].into(),
        };
        key.validate()?;
        Ok(key)
    }
    /// 客户端状态与不可变内容分离；逐层拒绝链接，调用方不得自行拼接并创建父目录。
    pub fn client_directory(&self, client: &str) -> Result<PathBuf> {
        paths::segment(client)?;
        paths::create_directory(
            &self.root,
            &PathBuf::from(".repository/clients").join(client),
        )
    }
    pub fn stage(&self) -> Result<tempfile::TempDir> {
        let directory = paths::create_directory(&self.root, Path::new(".repository/staging"))?;
        Ok(tempfile::tempdir_in(directory)?)
    }
    pub fn read(&self) -> Result<ReadLease> {
        Ok(ReadLease {
            repository: self.clone(),
            _lock: self.lock(false)?,
        })
    }
    pub fn write(&self) -> Result<WriteGuard> {
        Ok(WriteGuard {
            repository: self.clone(),
            _lock: self.lock(true)?,
        })
    }
    fn lock(&self, exclusive: bool) -> Result<fs::File> {
        use fs2::FileExt;
        paths::directory(&self.root)?;
        let path = self.root.join(".repository/repository.lock");
        if fs::symlink_metadata(&path).is_ok() {
            paths::file(&path)?;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        paths::file(&path)?;
        let result = if exclusive {
            FileExt::try_lock_exclusive(&file)
        } else {
            FileExt::try_lock_shared(&file)
        };
        result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
            {
                Error::Busy
            } else {
                Error::Io(error)
            }
        })?;
        Ok(file)
    }
}

impl ReadLease {
    /// 读租约内先登记调用独有的准备引用，再释放租约；避免发现到提交间被清理。
    /// owner 必须由调用方独占，不能与其他准备操作或正式绑定共用。
    pub fn set_references(&self, owner: &str, keys: &[ToolKey]) -> Result<()> {
        references::replace(&self.repository.root, owner, keys)
    }

    /// 仅用于调用方独占的临时所有者；释放后删除记录，避免准备任务累计空文件。
    pub fn clear_temporary_references(&self, owner: &str) -> Result<()> {
        references::clear_temporary(&self.repository.root, owner)
    }

    pub fn verify(&self, key: &ToolKey, check: &dyn Fn() -> Result<()>) -> Result<PathBuf> {
        let path = self.repository.path(key)?;
        paths::existing_directory(&self.repository.root, &key.relative()?)?;
        content::verify(&path, check)?;
        Ok(path)
    }
    pub fn verify_entry(&self, entry: &Path, check: &dyn Fn() -> Result<()>) -> Result<ToolKey> {
        let key = self.repository.key_for_entry(entry)?;
        self.verify(&key, check)?;
        paths::file(entry)?;
        if fs::canonicalize(entry)? != entry {
            return Err(Error::Invalid("工具入口目录越界"));
        }
        Ok(key)
    }
}

impl WriteGuard {
    pub fn verify(&self, key: &ToolKey, check: &dyn Fn() -> Result<()>) -> Result<PathBuf> {
        let path = self.repository.path(key)?;
        paths::existing_directory(&self.repository.root, &key.relative()?)?;
        content::verify(&path, check)?;
        Ok(path)
    }
    /// staged 必须位于同一仓库根内；新目录以重命名发布，已存在内容必须完整匹配。
    pub fn publish(
        &self,
        key: &ToolKey,
        staged: &Path,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<PathBuf> {
        check()?;
        key.validate()?;
        let identity_directory = paths::create_directory(
            &self.repository.root,
            &PathBuf::from(".repository/identities")
                .join(&key.id)
                .join(&key.version),
        )?;
        let identity_path = identity_directory.join(format!("{}.json", key.platform));
        if identity_path.exists() {
            let identity: ToolKey = paths::read(&identity_path, 4096)?;
            if identity != *key {
                return Err(Error::Invalid("同标识、版本和平台已绑定其他摘要"));
            }
        }
        let relative = staged
            .strip_prefix(&self.repository.root)
            .map_err(|_| Error::Invalid("暂存不在共享仓库内"))?;
        if !relative.starts_with(".repository/staging") || relative.components().count() < 4 {
            return Err(Error::Invalid("暂存目录层级无效"));
        }
        paths::existing_directory(&self.repository.root, relative)?;
        content::seal(staged, check)?;
        let destination = self.repository.path(key)?;
        if destination.exists() {
            let verified = self.verify(key, check)?;
            content::same(&verified, staged, check)?;
            if !identity_path.exists() {
                paths::write(&identity_path, key)?;
            }
            return Ok(verified);
        }
        let parent = key
            .relative()?
            .parent()
            .ok_or(Error::Invalid("工具层级无效"))?
            .to_owned();
        paths::create_directory(&self.repository.root, &parent)?;
        check()?;
        // 身份账本先落盘，进程中止只会保守保留身份，不允许重写同一版本内容。
        if !identity_path.exists() {
            paths::write(&identity_path, key)?;
        }
        fs::rename(staged, &destination)?;
        Ok(destination)
    }
    /// 所有者标识是公共调用方命名空间；旧引用直到新快照持久化成功前保持有效。
    pub fn set_references(&self, owner: &str, keys: &[ToolKey]) -> Result<()> {
        references::replace(&self.repository.root, owner, keys)
    }
    pub fn references(&self, key: &ToolKey) -> Result<Vec<String>> {
        references::owners(&self.repository.root, key)
    }
    /// 任意持久引用、活动调用共享租约或路径/内容损坏均阻止删除。
    pub fn remove(&self, key: &ToolKey, check: &dyn Fn() -> Result<()>) -> Result<u64> {
        check()?;
        if !self.references(key)?.is_empty() {
            return Err(Error::InUse);
        }
        let path = self.verify(key, check)?;
        let bytes = content::bytes(&path, check)?;
        paths::existing_directory(&self.repository.root, &key.relative()?)?;
        check()?;
        fs::remove_dir_all(path)?;
        Ok(bytes)
    }
}
