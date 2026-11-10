//! 受限阻塞工作池内读写单快照；原子提交不重试、不删除旧快照后再改名。
use super::budget;
use apk_domain::{Error, Result, plugin_guides::MAX_GUIDE_BYTES};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Instant,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const PREPARING: u8 = 0;
const ABORTED: u8 = 1;
const COMMITTING: u8 = 2;
const COMMITTED: u8 = 3;
const FAILED: u8 = 4;

/// 上层直接丢弃Future时也撤销尚未开始的提交，不依赖调用者额外发取消。
struct WorkerGuard {
    cancel: CancellationToken,
    commit: Option<Arc<AtomicU8>>,
}
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if let Some(commit) = &self.commit {
            let _ =
                commit.compare_exchange(PREPARING, ABORTED, Ordering::AcqRel, Ordering::Acquire);
        }
        self.cancel.cancel();
    }
}

pub(super) async fn load(
    root: PathBuf,
    workers: Arc<Semaphore>,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<Option<Vec<u8>>> {
    let permit = budget::wait(deadline, &cancel, async {
        workers.acquire_owned().await.map_err(|_| Error::Cancelled)
    })
    .await?;
    let worker_cancel = cancel.child_token();
    let _cleanup = WorkerGuard {
        cancel: worker_cancel.clone(),
        commit: None,
    };
    let token = worker_cancel.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        budget::check(deadline, &token)?;
        let path = root.join("current.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage("指南缓存不可读取".into())),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Error::Storage("指南缓存必须是普通文件".into()));
        }
        if metadata.len() > MAX_GUIDE_BYTES as u64 {
            return Err(Error::TooLarge);
        }
        let mut file = File::open(path).map_err(|_| Error::Storage("指南缓存打开失败".into()))?;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            budget::check(deadline, &token)?;
            let read = file
                .read(&mut chunk)
                .map_err(|_| Error::Storage("指南缓存读取失败".into()))?;
            if read == 0 {
                return Ok(Some(bytes));
            }
            if read > MAX_GUIDE_BYTES.saturating_sub(bytes.len()) {
                return Err(Error::TooLarge);
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
    });
    let result = budget::wait(deadline, &cancel, async {
        task.await
            .map_err(|_| Error::Storage("指南缓存读取工作结束异常".into()))?
    })
    .await;
    worker_cancel.cancel();
    result
}

/// 暂存路径只在本次成功create_new后拥有，不扫描或删除任何其他文件。
struct Staged(PathBuf);
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) async fn save(
    root: PathBuf,
    bytes: Vec<u8>,
    workers: Arc<Semaphore>,
    writers: Arc<Semaphore>,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<()> {
    if bytes.len() > MAX_GUIDE_BYTES {
        return Err(Error::TooLarge);
    }
    let writer = budget::wait(deadline, &cancel, async {
        writers.acquire_owned().await.map_err(|_| Error::Cancelled)
    })
    .await?;
    let permit = budget::wait(deadline, &cancel, async {
        workers.acquire_owned().await.map_err(|_| Error::Cancelled)
    })
    .await?;
    let stage = Arc::new(AtomicU8::new(PREPARING));
    let commit = stage.clone();
    let worker_cancel = cancel.child_token();
    let _cleanup = WorkerGuard {
        cancel: worker_cancel.clone(),
        commit: Some(stage.clone()),
    };
    let token = worker_cancel.clone();
    let task = tokio::task::spawn_blocking(move || {
        let (_writer, _permit) = (writer, permit);
        prepare_and_commit(root, &bytes, deadline, &token, &commit)
    });
    let result = budget::wait(deadline, &cancel, async {
        task.await
            .map_err(|_| Error::Storage("指南缓存保存工作结束异常".into()))?
    })
    .await;
    if result.is_err() {
        // 成功撤销准备资格后，即使阻塞任务稍后获得执行机会，也不能开始提交。
        match stage.compare_exchange(PREPARING, ABORTED, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) | Err(ABORTED | FAILED) => {}
            Err(COMMITTED) => return Ok(()),
            Err(COMMITTING) => {
                worker_cancel.cancel();
                return Err(Error::Conflict(
                    "指南缓存提交结果未确认，请重新读取；不会自动重试".into(),
                ));
            }
            Err(_) => {}
        }
    }
    worker_cancel.cancel();
    result
}

fn prepare_and_commit(
    root: PathBuf,
    bytes: &[u8],
    deadline: Instant,
    cancel: &CancellationToken,
    commit: &AtomicU8,
) -> Result<()> {
    budget::check(deadline, cancel)?;
    fs::create_dir_all(&root).map_err(|_| Error::Storage("指南缓存目录创建失败".into()))?;
    budget::check(deadline, cancel)?;
    let path = root.join(format!(".guide-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| Error::Storage("指南缓存暂存创建失败".into()))?;
    let staged = Staged(path);
    for chunk in bytes.chunks(16 * 1024) {
        budget::check(deadline, cancel)?;
        file.write_all(chunk)
            .map_err(|_| Error::Storage("指南缓存暂存写入失败".into()))?;
    }
    file.flush()
        .map_err(|_| Error::Storage("指南缓存暂存刷新失败".into()))?;
    file.sync_all()
        .map_err(|_| Error::Storage("指南缓存暂存同步失败".into()))?;
    drop(file);
    budget::check(deadline, cancel)?;
    commit
        .compare_exchange(PREPARING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| Error::Cancelled)?;
    match fs::rename(&staged.0, root.join("current.json")) {
        Ok(()) => {
            commit.store(COMMITTED, Ordering::Release);
            Ok(())
        }
        Err(_) => {
            commit.store(FAILED, Ordering::Release);
            Err(Error::Storage("指南缓存原子保存失败，保留此前缓存".into()))
        }
    }
}
