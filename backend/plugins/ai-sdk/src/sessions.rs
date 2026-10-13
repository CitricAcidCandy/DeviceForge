use crate::model::{PROFILE, PROVIDER, SDK_VERSION, normalize_thread};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub format_version: u32,
    pub provider: String,
    pub sdk_version: String,
    pub profile: String,
    pub project_id: String,
    pub project_root: PathBuf,
    pub thread_id: String,
    pub turns: u64,
    pub closed: bool,
    pub uncertain: bool,
}

pub struct Lease {
    _lock: File,
    path: PathBuf,
    snapshot: Option<Snapshot>,
    project_id: String,
    project_root: PathBuf,
    thread_id: String,
}

fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "无法创建SDK资格目录")?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法检查SDK资格目录")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("SDK资格目录不能是链接".into());
    }
    Ok(())
}

impl Lease {
    pub fn acquire(
        root: &Path,
        project_id: &str,
        project_root: &Path,
        thread: &str,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        let thread_id = normalize_thread(thread)?;
        check()?;
        directory(root)?;
        let threads = root.join("threads");
        directory(&threads)?;
        let threads = fs::canonicalize(threads).map_err(|_| "无法规范化SDK资格目录")?;
        let lock_path = threads.join(format!("{thread_id}.lock"));
        if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("SDK资格锁不能是链接".into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "无法打开SDK资格锁")?;
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
                Err(_) => return Err("SDK资格锁失败".into()),
            }
        }
        check()?;
        let path = threads.join(format!("{thread_id}.json"));
        let snapshot = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= 16_384 =>
            {
                let bytes = fs::read(&path).map_err(|_| "无法读取SDK资格")?;
                if bytes.len() > 16_384 {
                    return Err("SDK资格文件超限".into());
                }
                let state: Snapshot =
                    serde_json::from_slice(&bytes).map_err(|_| "SDK资格元数据损坏，保留原文件")?;
                if state.format_version != 1
                    || state.provider != PROVIDER
                    || state.sdk_version != SDK_VERSION
                    || state.profile != PROFILE
                    || state.project_id != project_id
                    || state.project_root != project_root
                    || state.thread_id != thread_id
                {
                    return Err("SDK线程提供者、项目目录或固定档案不匹配".into());
                }
                Some(state)
            }
            _ => return Err("SDK资格文件类型或大小无效".into()),
        };
        Ok(Self {
            _lock: lock,
            path,
            snapshot,
            project_id: project_id.into(),
            project_root: project_root.into(),
            thread_id,
        })
    }

    pub fn snapshot(&self) -> Result<&Snapshot, String> {
        self.snapshot
            .as_ref()
            .ok_or_else(|| "SDK线程未登记，不能接管外部历史".into())
    }

    pub fn register(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        if self.snapshot.is_some() {
            return Err("SDK返回已登记线程，拒绝覆盖归属".into());
        }
        self.commit(
            Snapshot {
                format_version: 1,
                provider: PROVIDER.into(),
                sdk_version: SDK_VERSION.into(),
                profile: PROFILE.into(),
                project_id: self.project_id.clone(),
                project_root: self.project_root.clone(),
                thread_id: self.thread_id.clone(),
                turns: 0,
                closed: false,
                uncertain: true,
            },
            check,
        )
    }

    pub fn begin(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        let mut state = self.snapshot()?.clone();
        if state.closed || state.uncertain || state.turns == u64::MAX {
            return Err("SDK线程已关闭、不确定或轮次已耗尽，不能恢复".into());
        }
        state.uncertain = true;
        self.commit(state, check)
    }

    pub fn complete(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<u64, String> {
        let mut state = self.snapshot()?.clone();
        if !state.uncertain || state.closed {
            return Err("SDK没有可确认的在途轮次".into());
        }
        state.turns = state.turns.checked_add(1).ok_or("SDK轮次已耗尽")?;
        state.uncertain = false;
        let turns = state.turns;
        self.commit(state, check)?;
        Ok(turns)
    }

    pub fn close(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        let mut state = self.snapshot()?.clone();
        state.closed = true;
        self.commit(state, check)
    }

    fn commit(
        &mut self,
        state: Snapshot,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(&state).map_err(|_| "SDK资格序列化失败")?;
        if bytes.len() > 16_384 {
            return Err("SDK资格元数据超限".into());
        }
        let parent = self.path.parent().ok_or("SDK资格目录无效")?;
        let mut staged =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法准备SDK资格提交")?;
        staged
            .write_all(&bytes)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| "无法写入SDK资格提交")?;
        check()?;
        staged
            .persist(&self.path)
            .map_err(|_| "SDK资格提交失败，保留原文件")?;
        self.snapshot = Some(state);
        Ok(())
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
