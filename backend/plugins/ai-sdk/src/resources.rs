use crate::{
    config::Config,
    model::normalize_thread,
    sessions::{Lease, Snapshot},
};
use deviceforge_plugin_runtime::InvocationContext;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

struct State {
    lease: Option<Lease>,
    temporary: Option<tempfile::TempDir>,
    temporary_path: Option<PathBuf>,
    confirmed: bool,
}

pub struct Resources {
    config: Arc<Config>,
    project_id: String,
    project_root: PathBuf,
    state: Mutex<State>,
    blocking: Arc<Semaphore>,
}

impl Resources {
    pub fn new(config: Arc<Config>, project_id: String, project_root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            config,
            project_id,
            project_root,
            state: Mutex::new(State {
                lease: None,
                temporary: None,
                temporary_path: None,
                confirmed: false,
            }),
            blocking: Arc::new(Semaphore::new(1)),
        })
    }

    async fn work<T: Send + 'static>(
        self: &Arc<Self>,
        context: &InvocationContext,
        work: impl FnOnce(&Self, &InvocationContext) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        context.check().map_err(|error| error.to_string())?;
        let permit = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(context.deadline())) => return Err("SDK阻塞工作排队期限已到期".into()),
            _ = context.cancellation().cancelled_owned() => return Err("SDK阻塞工作已取消".into()),
            permit = self.blocking.clone().acquire_owned() => permit.map_err(|_| "SDK阻塞工作池已关闭")?,
        };
        let owner = self.clone();
        let context = context.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            context.check().map_err(|error| error.to_string())?;
            work(&owner, &context)
        })
        .await
        .map_err(|_| "SDK阻塞worker退出失败")?
    }

    pub async fn temporary(
        self: &Arc<Self>,
        context: &InvocationContext,
    ) -> Result<PathBuf, String> {
        self.work(context, |owner, context| {
            let parent = owner.config.state_root.join("temporary");
            std::fs::create_dir_all(&parent).map_err(|_| "SDK临时目录准备失败")?;
            let metadata =
                std::fs::symlink_metadata(&parent).map_err(|_| "SDK临时目录资格检查失败")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("SDK临时目录资格无效".into());
            }
            context.check().map_err(|error| error.to_string())?;
            let temporary = tempfile::Builder::new()
                .prefix("sdk-")
                .tempdir_in(parent)
                .map_err(|_| "SDK调用临时目录创建失败")?;
            let path = temporary.path().to_owned();
            let mut state = owner.state.lock().map_err(|_| "SDK资源所有权损坏")?;
            if state.temporary.is_some() {
                return Err("SDK调用临时目录重复准备".into());
            }
            state.temporary = Some(temporary);
            Ok(path)
        })
        .await
    }

    pub async fn resume(
        self: &Arc<Self>,
        context: &InvocationContext,
        thread: String,
    ) -> Result<(), String> {
        self.work(context, move |owner, context| {
            let check = || context.check().map_err(|error| error.to_string());
            let mut lease = Lease::acquire(
                &owner.config.state_root,
                &owner.project_id,
                &owner.project_root,
                &thread,
                &check,
            )?;
            lease.begin(&check)?;
            let mut state = owner.state.lock().map_err(|_| "SDK资源所有权损坏")?;
            if state.lease.is_some() {
                return Err("SDK恢复线程资格重复取得".into());
            }
            state.lease = Some(lease);
            Ok(())
        })
        .await
    }

    pub async fn register(
        self: &Arc<Self>,
        context: &InvocationContext,
        thread: String,
    ) -> Result<(), String> {
        self.work(context, move |owner, context| {
            let check = || context.check().map_err(|error| error.to_string());
            let thread = normalize_thread(&thread)?;
            let mut state = owner.state.lock().map_err(|_| "SDK资源所有权损坏")?;
            if let Some(lease) = &state.lease {
                if lease.snapshot()?.thread_id != thread {
                    return Err("SDK实际线程与独占资格冲突".into());
                }
                return Ok(());
            }
            let mut lease = Lease::acquire(
                &owner.config.state_root,
                &owner.project_id,
                &owner.project_root,
                &thread,
                &check,
            )?;
            lease.register(&check)?;
            state.lease = Some(lease);
            Ok(())
        })
        .await
    }

    pub async fn commit(
        self: &Arc<Self>,
        context: &InvocationContext,
        until: std::time::Instant,
    ) -> Result<u64, String> {
        let worker = self.work(context, move |owner, context| {
            let mut state = owner.state.lock().map_err(|_| "SDK资源所有权损坏")?;
            state.clean_temporary()?;
            let check = || {
                context.check().map_err(|error| error.to_string())?;
                if std::time::Instant::now() >= until {
                    return Err("SDK成功提交清理窗口已到期".into());
                }
                Ok(())
            };
            let turns = state
                .lease
                .as_mut()
                .ok_or("SDK成功提交缺少独占线程资格")?
                .complete(&check)?;
            state.confirmed = true;
            Ok(turns)
        });
        tokio::time::timeout_at(tokio::time::Instant::from_std(until), worker)
            .await
            .map_err(|_| "SDK成功提交worker实际结束未确认")?
    }

    pub async fn cleanup(self: &Arc<Self>, until: std::time::Instant) -> Result<(), String> {
        let permit = tokio::time::timeout_at(
            tokio::time::Instant::from_std(until),
            self.blocking.clone().acquire_owned(),
        )
        .await
        .map_err(|_| "SDK资源清理worker等待超时")?
        .map_err(|_| "SDK阻塞工作池已关闭")?;
        let owner = self.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut state = owner.state.lock().map_err(|_| "SDK资源所有权损坏")?;
            if std::time::Instant::now() >= until {
                return Err("SDK资源清理期限已到期".into());
            }
            state.clean_temporary()?;
            state.confirmed = true;
            Ok(())
        });
        tokio::time::timeout_at(tokio::time::Instant::from_std(until), worker)
            .await
            .map_err(|_| "SDK资源清理实际结束未确认")?
            .map_err(|_| "SDK资源清理worker失败")?
    }

    pub async fn inspect(
        config: Arc<Config>,
        context: InvocationContext,
        project_id: String,
        project_root: PathBuf,
        thread: String,
        close: bool,
    ) -> Result<Snapshot, String> {
        let owner = Self::new(config, project_id, project_root);
        owner
            .work(&context, move |owner, context| {
                let check = || context.check().map_err(|error| error.to_string());
                let mut lease = Lease::acquire(
                    &owner.config.state_root,
                    &owner.project_id,
                    &owner.project_root,
                    &thread,
                    &check,
                )?;
                if close {
                    lease.close(&check)?;
                }
                Ok(lease.snapshot()?.clone())
            })
            .await
    }
}

impl State {
    fn clean_temporary(&mut self) -> Result<(), String> {
        if let Some(temporary) = self.temporary.take() {
            self.temporary_path = Some(temporary.path().into());
            temporary.close().map_err(|_| "SDK调用临时目录清理失败")?;
            self.temporary_path = None;
        }
        if let Some(path) = &self.temporary_path {
            match std::fs::remove_dir_all(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("SDK调用临时目录清理失败".into()),
            }
            self.temporary_path = None;
        }
        Ok(())
    }
}

impl Drop for Resources {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut()
            && !state.confirmed
        {
            if let Some(lease) = state.lease.take() {
                std::mem::forget(lease);
            }
            if let Some(temporary) = state.temporary.take() {
                std::mem::forget(temporary);
            }
        }
    }
}
