//! 有界文件工作池、永久锁文件与原子发布；不执行设备命令。
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions, TryLockError},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

static WORKERS: Semaphore = Semaphore::const_new(4);
pub(super) const LIMIT: usize = 32 * 1024;
pub(super) const RECORD_LIMIT: usize = 48;
const SCAN_BATCH: usize = 128;
const SCAN_BUDGET: Duration = Duration::from_secs(3);

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|_| "无法定位投屏插件")?
        .parent()
        .ok_or_else(|| "无法定位投屏部署目录".into())
        .map(|parent| parent.join(".mirroring-resources"))
}

pub(super) async fn io<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = tokio::time::timeout(std::time::Duration::from_secs(3), WORKERS.acquire())
        .await
        .map_err(|_| "资源台账工作池等待超时")?
        .map_err(|_| "资源台账工作池已关闭")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| "资源台账工作线程失败")?
}

pub(super) fn prepare(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|_| "无法创建资源台账目录")?;
    let meta = std::fs::symlink_metadata(root).map_err(|_| "无法检查资源台账目录")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("资源台账目录不是可信普通目录".into());
    }
    Ok(())
}

pub(super) fn lock(path: &Path, shared: bool) -> Result<Option<Arc<File>>, String> {
    if let Ok(meta) = std::fs::symlink_metadata(path)
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        return Err("资源租约不是普通文件".into());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "无法打开资源租约")?;
    let result = if shared {
        file.try_lock_shared()
    } else {
        file.try_lock()
    };
    match result {
        Ok(()) => Ok(Some(Arc::new(file))),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err("无法核对资源租约".into()),
    }
}

pub(crate) async fn process_lease(shared: bool) -> Result<Option<Arc<File>>, String> {
    io(move || {
        let root = root()?;
        prepare(&root)?;
        lock(&root.join("process.lock"), shared)
    })
    .await
}

pub(super) async fn device_gate(root: &Path, device: &str) -> Result<Arc<File>, String> {
    let path = root.join(format!("{}.gate", digest(device)));
    io(move || lock(&path, false)?.ok_or_else(|| "目标设备正在核对或登记资源".into())).await
}

pub(super) fn read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "无法读取资源台账")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > LIMIT as u64 {
        return Err("资源台账不是有限普通文件".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "无法打开资源台账")?
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "资源台账读取失败")?;
    if bytes.len() > LIMIT {
        return Err("资源台账超限".into());
    }
    Ok(bytes)
}

pub(super) fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > LIMIT {
        return Err("资源台账超限".into());
    }
    let pending = path.with_extension("pending");
    if let Ok(meta) = std::fs::symlink_metadata(&pending)
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        return Err("资源台账暂存目标不可信".into());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|_| "无法暂存资源台账")?;
    file.write_all(bytes).map_err(|_| "资源台账写入失败")?;
    file.sync_all().map_err(|_| "资源台账刷新失败")?;
    drop(file);
    super::atomic::replace(&pending, path)
}

pub(super) fn paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let deadline = Instant::now() + SCAN_BUDGET;
    paths_with_check(root, || {
        if Instant::now() >= deadline {
            Err("资源台账枚举总预算已到期，未将部分扫描报告为成功".into())
        } else {
            Ok(())
        }
    })
}

pub(super) fn registration_capacity(root: &Path) -> Result<(), String> {
    let deadline = Instant::now() + SCAN_BUDGET;
    let entries = std::fs::read_dir(root).map_err(|_| "无法枚举本地资源登记容量")?;
    let mut obligations = std::collections::BTreeSet::new();
    for (index, entry) in entries.enumerate() {
        if index.is_multiple_of(SCAN_BATCH) {
            std::thread::yield_now();
            if Instant::now() >= deadline {
                return Err("本地资源登记容量检查到期".into());
            }
        }
        let entry = entry.map_err(|_| "本地资源登记容量读取失败")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta =
            std::fs::symlink_metadata(entry.path()).map_err(|_| "本地资源登记条目检查失败")?;
        if historical_lock(&name) && meta.is_file() && meta.len() == 0 {
            continue;
        }
        // 损坏旧记录、暂存和未知文件保留为容量债务，但不审计内容或全局拒绝新资源。
        let obligation = name
            .strip_suffix(".json")
            .or_else(|| name.strip_suffix(".pending"));
        obligations.insert(obligation.unwrap_or(&name).to_owned());
        if obligations.len() >= RECORD_LIMIT {
            return Err("投屏资源登记及待回收债务已达容量上限".into());
        }
    }
    if Instant::now() >= deadline {
        return Err("本地资源登记容量检查到期".into());
    }
    Ok(())
}

fn historical_lock(name: &str) -> bool {
    if matches!(name, "process.lock" | "catalog.lock") {
        return true;
    }
    [(".lease", 32), (".gate", 64)]
        .into_iter()
        .any(|(suffix, length)| {
            name.strip_suffix(suffix).is_some_and(|token| {
                token.len() == length
                    && token
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        })
}

pub(super) fn paths_with_check(
    root: &Path,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Vec<PathBuf>, String> {
    check()?;
    let mut records = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|_| "无法枚举资源台账")?;
    let mut batch = 0;
    for entry in entries {
        if batch == SCAN_BATCH {
            // 历史锁不占活动额度，但遍历仍按批次让出线程并检查同一总预算。
            std::thread::yield_now();
            check()?;
            batch = 0;
        }
        batch += 1;
        let entry = entry.map_err(|_| "资源台账目录读取失败")?;
        let path = entry.path();
        let meta = entry.metadata().map_err(|_| "资源台账条目检查失败")?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("资源台账目录包含非普通文件，不能跳过未知资源".into());
        }
        if path.extension().is_some_and(|value| value == "json") {
            records.push(path);
            if records.len() > RECORD_LIMIT {
                return Err("待核对资源台账超限".into());
            }
        } else {
            let name = entry.file_name();
            if !name.to_str().is_some_and(historical_lock) || meta.len() != 0 {
                return Err("资源台账目录包含未知文件、暂存记录或损坏租约，保留阻断".into());
            }
        }
    }
    check()?;
    records.sort();
    Ok(records)
}
