//! 原生线程归属持久化；文件锁跨插件进程持有到本轮真实退出。
use crate::model::valid_thread;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub format_version: u32,
    pub project_id: String,
    pub project_root: PathBuf,
    pub thread_id: String,
    pub turns: u64,
    pub closed: bool,
    pub uncertain: bool,
}

pub(crate) struct Lease {
    _lock: File,
    path: PathBuf,
    pub snapshot: Option<Snapshot>,
}

fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "无法创建AI会话目录")?;
    let meta = fs::symlink_metadata(path).map_err(|_| "无法检查AI会话目录")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("AI会话目录不能是链接".into());
    }
    Ok(())
}

impl Lease {
    pub(crate) fn acquire(
        root: &Path,
        id: &str,
        project_id: &str,
        project_root: &Path,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        if !valid_thread(id) {
            return Err("AI线程标识无效".into());
        }
        check()?;
        directory(root)?;
        let threads = root.join("threads");
        directory(&threads)?;
        // 受控目录检查后统一长路径前缀，使临时源与原子提交目标共用规范化父目录。
        #[cfg(windows)]
        let threads = fs::canonicalize(&threads).map_err(|_| "无法规范化AI会话目录".to_owned())?;
        // UUID 大小写必须归一，避免用同一原生线程绕过文件锁。
        let id = id.to_ascii_lowercase();
        let lock_path = threads.join(format!("{id}.lock"));
        if fs::symlink_metadata(&lock_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("AI会话锁不能是链接".into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "无法打开AI会话锁")?;
        loop {
            check()?;
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => return Err("AI会话锁失败".into()),
            }
        }
        check()?;
        let path = threads.join(format!("{id}.json"));
        let snapshot = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16384 => {
                let raw = fs::read(&path).map_err(|_| "无法读取AI会话")?;
                let state: Snapshot =
                    serde_json::from_slice(&raw).map_err(|_| "AI会话元数据损坏，保留原文件")?;
                if state.format_version != 1
                    || state.thread_id != id
                    || state.project_id != project_id
                    || state.project_root != project_root
                {
                    return Err("AI线程不属于该项目或项目目录已变化".into());
                }
                Some(state)
            }
            _ => return Err("AI会话文件类型或大小无效".into()),
        };
        Ok(Self {
            _lock: lock,
            path,
            snapshot,
        })
    }

    pub(crate) fn begin(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        let mut state = self
            .snapshot
            .as_ref()
            .ok_or("AI线程未登记，不能恢复外部未知线程")?
            .clone();
        if state.closed {
            return Err("AI线程已关闭".into());
        }
        if state.uncertain {
            return Err("AI线程上一轮未确认完成，请关闭后创建新线程".into());
        }
        if state.turns == u64::MAX {
            return Err("AI轮次数已耗尽".into());
        }
        state.uncertain = true;
        self.commit(state, check)
    }

    pub(crate) fn complete(
        &mut self,
        project_id: String,
        project_root: PathBuf,
        id: String,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let turns = self
            .snapshot
            .as_ref()
            .map_or(0, |state| state.turns)
            .checked_add(1)
            .ok_or("AI轮次数已耗尽")?;
        let state = Snapshot {
            format_version: 1,
            project_id,
            project_root,
            thread_id: id.to_ascii_lowercase(),
            turns,
            closed: false,
            uncertain: false,
        };
        self.commit(state, check)
    }

    pub(crate) fn close(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        let mut state = self.snapshot.as_ref().ok_or("AI线程不存在")?.clone();
        state.closed = true;
        self.commit(state, check)
    }

    fn commit(
        &mut self,
        state: Snapshot,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let raw = serde_json::to_vec(&state).map_err(|_| "AI会话序列化失败")?;
        if raw.len() > 16384 {
            return Err("AI会话元数据超限".into());
        }
        let parent = self.path.parent().ok_or("AI会话目录无效")?;
        let mut staged =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法准备AI会话提交")?;
        staged
            .write_all(&raw)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| "无法写入AI会话提交")?;
        check()?;
        staged
            .persist(&self.path)
            .map_err(|_| "AI会话提交失败，保留原文件")?;
        self.snapshot = Some(state);
        Ok(())
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

#[cfg(all(test, windows))]
#[path = "session_path_tests.rs"]
mod path_tests;
