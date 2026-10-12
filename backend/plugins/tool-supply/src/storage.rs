//! 每模块状态随目录一同替换；跨进程文件锁保护整个安装和移除过程。
use crate::{
    budget::Budget,
    config::{Config, read_bounded},
    error::{Error, Result},
    input::valid_id,
    manifest::version_parts,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const STATE_FILE: &str = ".tool-supply-state.json";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Installed {
    pub module_id: String,
    pub version: String,
    pub sha256: String,
    pub manifest_version: String,
    pub installed_at_ms: u64,
    pub kind: String,
    pub entry_file: Option<String>,
    pub feature_key: Option<String>,
    // 旧状态缺少根目录时允许读取，但不能证明当前安装内容的选择资格。
    #[serde(default)]
    pub archive_root: Option<String>,
}
pub(crate) fn directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(Error::Io("创建插件内部目录失败")),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Io("检查插件内部目录失败"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("插件内部目录禁止链接或普通文件"));
    }
    Ok(())
}
pub(crate) struct ModuleLock {
    _file: File,
}
impl ModuleLock {
    pub fn acquire(config: &Config, id: &str, budget: &Budget) -> Result<Self> {
        budget.check()?;
        if !valid_id(id) {
            return Err(Error::Invalid("模块 ID 无效"));
        }
        let locks = config.root.join(".locks");
        directory(&locks)?;
        let path = locks.join(format!("{id}.lock"));
        if optional_metadata(fs::symlink_metadata(&path), "检查模块锁失败")?
            .is_some_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(Error::Invalid("模块锁不能是链接或目录"));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| Error::Io("打开模块锁失败"))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                budget.check()?;
                if optional_metadata(
                    fs::symlink_metadata(config.root.join(".transactions").join(id)),
                    "检查模块安装事务失败",
                )?
                .is_some()
                {
                    return Err(Error::Cleanup);
                }
                Ok(Self { _file: file })
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                Err(Error::Busy)
            }
            Err(_) => Err(Error::Io("获取模块锁失败")),
        }
    }
}
fn optional_metadata(
    result: std::io::Result<fs::Metadata>,
    message: &'static str,
) -> Result<Option<fs::Metadata>> {
    match result {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Error::Io(message)),
    }
}
pub(crate) fn metadata(path: &Path, message: &'static str) -> Result<Option<fs::Metadata>> {
    optional_metadata(fs::symlink_metadata(path), message)
}
pub(crate) fn target(config: &Config, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(Error::Invalid("模块 ID 无效"));
    }
    let target = config.root.join(id);
    if metadata(&target, "检查模块目标失败")?
        .is_some_and(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink())
    {
        return Err(Error::Invalid("模块目标必须是根目录内的普通目录"));
    }
    Ok(target)
}
pub(crate) fn installed(config: &Config, id: &str, budget: &Budget) -> Result<Option<Installed>> {
    budget.check()?;
    let target = target(config, id)?;
    if metadata(&target, "检查模块目标失败")?.is_none() {
        return Ok(None);
    }
    let bytes =
        read_bounded(&target.join(STATE_FILE), 64 * 1024, budget).map_err(|error| match error {
            Error::Cancelled | Error::Timeout | Error::TooLarge => error,
            _ => Error::Invalid("目标已有非托管目录或损坏状态，拒绝覆盖"),
        })?;
    let state: Installed =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("本地模块状态损坏"))?;
    version_parts(&state.version)?;
    if state.module_id != id
        || state.sha256.len() != 64
        || !state.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(Error::Invalid("本地模块状态身份或摘要损坏"));
    }
    if state.manifest_version.is_empty()
        || state.manifest_version.len() > 128
        || (state.kind != "tool" && state.kind != "runtime")
        || state
            .feature_key
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > 128)
    {
        return Err(Error::Invalid("本地模块状态字段超出约束"));
    }
    if let Some(entry) = &state.entry_file {
        crate::unpack::relative(entry, false)?;
    }
    if let Some(root) = &state.archive_root {
        crate::unpack::relative(root, true)?;
    }
    Ok(Some(state))
}
pub(crate) fn check_local_stable(config: &Config, budget: &Budget) -> Result<()> {
    budget.check()?;
    let mut ids = BTreeSet::new();
    for entry in fs::read_dir(&config.root).map_err(|_| Error::Io("读取安装目录失败"))? {
        budget.check()?;
        let entry = entry.map_err(|_| Error::Io("读取模块目录失败"))?;
        if let Some(id) = entry.file_name().to_str()
            && valid_id(id)
        {
            ids.insert(id.to_owned());
            if ids.len() > 128 {
                return Err(Error::TooLarge);
            }
        }
    }
    let transactions = config.root.join(".transactions");
    if let Some(metadata) = metadata(&transactions, "检查未完成安装事务失败")? {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::Cleanup);
        }
        for entry in fs::read_dir(&transactions).map_err(|_| Error::Io("检查未完成安装事务失败"))?
        {
            budget.check()?;
            let entry = entry.map_err(|_| Error::Io("检查未完成安装事务失败"))?;
            let name = entry.file_name();
            let Some(id) = name.to_str().filter(|id| valid_id(id)) else {
                return Err(Error::Cleanup);
            };
            ids.insert(id.to_owned());
            if ids.len() > 128 {
                return Err(Error::TooLarge);
            }
        }
    }
    for id in ids {
        budget.check()?;
        let _lock = ModuleLock::acquire(config, &id, budget)?;
        if metadata(&config.root.join(&id), "检查模块目录失败")?
            .is_some_and(|metadata| metadata.is_dir() || metadata.file_type().is_symlink())
        {
            installed(config, &id, budget)?;
        }
    }
    budget.check()
}
pub(crate) fn all_installed(config: &Config, budget: &Budget) -> Result<Vec<Installed>> {
    let mut output = Vec::new();
    for entry in fs::read_dir(&config.root).map_err(|_| Error::Io("读取安装目录失败"))? {
        budget.check()?;
        let entry = entry.map_err(|_| Error::Io("读取模块目录失败"))?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_id(&id) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| Error::Io("检查模块目录失败"))?;
        if !metadata.is_dir() && !metadata.file_type().is_symlink() {
            continue;
        }
        if output.len() >= 128 {
            return Err(Error::TooLarge);
        }
        if let Some(state) = installed(config, &id, budget)? {
            output.push(state);
        }
    }
    output.sort_by(|left, right| left.module_id.cmp(&right.module_id));
    Ok(output)
}
pub(crate) fn write_state(payload: &Path, state: &Installed, budget: &Budget) -> Result<()> {
    budget.check()?;
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|_| Error::Invalid("本地状态序列化失败"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(payload.join(STATE_FILE))
        .map_err(|_| Error::Io("创建暂存模块状态失败"))?;
    file.write_all(&bytes)
        .map_err(|_| Error::Io("写入暂存模块状态失败"))?;
    file.sync_all()
        .map_err(|_| Error::Io("持久化暂存模块状态失败"))?;
    budget.check()
}
pub(crate) fn remove_tree(config: &Config, path: &Path) -> Result<()> {
    if !path.is_absolute() || path == config.root || !path.starts_with(&config.root) {
        return Err(Error::Cleanup);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Cleanup)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Cleanup);
    }
    fs::remove_dir_all(path).map_err(|_| Error::Cleanup)
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
