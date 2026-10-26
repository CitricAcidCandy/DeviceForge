//! 通用插件依赖的文件适配：发现、真实校验、独立绑定及按需安装。
mod archive;
mod configurations;
mod discovery;
mod download;
mod environment;
mod failures;
mod files;
mod local_index;
mod preparation;
mod state;
mod targets;
mod workflow;

#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod work_queue_tests;

use apk_domain::{Error, Result, plugin_dependencies::*};
use deviceforge_tool_repository::{Repository, ToolKey};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct FilePluginDependencies {
    root: PathBuf,
    server_roots: Vec<PathBuf>,
    browser_roots: Vec<PathBuf>,
    repository: Repository,
    client: reqwest::Client,
    workers: Arc<Semaphore>,
    work_queue: Arc<Semaphore>,
    changes: Arc<Mutex<()>>,
}

impl FilePluginDependencies {
    pub async fn open(
        root: &Path,
        server_roots: Vec<PathBuf>,
        browser_roots: Vec<PathBuf>,
    ) -> Result<Arc<Self>> {
        let root = root.to_owned();
        tokio::task::spawn_blocking(move || {
            let root = files::directory(&root)?;
            files::directory(&root.join("plugin-dependencies/index"))?;
            files::directory(&root.join("plugin-dependencies/bindings/server"))?;
            files::directory(&root.join("plugin-dependencies/bindings/browser"))?;
            let repository = Repository::open(&root.join("tools")).map_err(repository_error)?;
            let normalize = |roots: Vec<PathBuf>| -> Result<Vec<PathBuf>> {
                let mut normalized = Vec::new();
                for path in roots {
                    let path = files::directory(&path)?;
                    if !normalized.contains(&path) {
                        normalized.push(path);
                    }
                }
                Ok(normalized)
            };
            let server_roots = normalize(server_roots)?;
            let browser_roots = normalize(browser_roots)?;
            Ok(Arc::new(Self {
                root,
                server_roots,
                browser_roots,
                repository,
                client: download::client()?,
                workers: Arc::new(Semaphore::new(2)),
                work_queue: Arc::new(Semaphore::new(64)),
                changes: Arc::new(Mutex::new(())),
            }))
        })
        .await
        .map_err(|_| Error::Storage("依赖存储初始化异常".into()))?
    }

    async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        // 短时并行读取允许有限排队，不把两个工作槽占满误报为仓库冲突。
        let waiting = self
            .work_queue
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("依赖工作等待队列已满，请稍后重试".into()))?;
        let permit =
            tokio::time::timeout(Duration::from_secs(2), self.workers.clone().acquire_owned())
                .await
                .map_err(|_| Error::Conflict("依赖工作池等待超时，请稍后重试".into()))?
                .map_err(|_| Error::Storage("依赖工作池已关闭".into()))?;
        drop(waiting);
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work(&store)
        })
        .await
        .map_err(|_| Error::Storage("依赖文件工作异常".into()))?
    }

    /// 启动只扫描，不下载；单目标失败继续处理其他目标，最终仍如实返回首个错误。
    pub async fn bootstrap_scan(&self, cancel: CancellationToken) -> Result<()> {
        let targets = self.work(|store| store.targets()).await?;
        let mut failure = None;
        for target in targets {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let result = async {
                let view = self.get(target.clone()).await?;
                self.scan(
                    DependencyRequest {
                        target,
                        expected_revision: view.revision,
                        dependency_ids: Vec::new(),
                    },
                    cancel.clone(),
                    apk_domain::ExecutionContext::default(),
                    Arc::new(apk_domain::NoProgress),
                )
                .await
            }
            .await;
            if let Err(error) = result {
                if matches!(error, Error::Cancelled) {
                    return Err(error);
                }
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// 供配置与调用适配器查询当前部署身份有效的组件快照。
    pub async fn component_snapshot(
        &self,
        kind: DependencyTargetKind,
        id: &str,
    ) -> Result<Option<PathBuf>> {
        let id = id.to_owned();
        self.work(move |store| {
            let target = store.resolve(DependencyTarget {
                kind,
                id: id.clone(),
            })?;
            let component = target
                .components
                .iter()
                .find(|component| component.id == id && component.kind == kind)
                .ok_or_else(|| Error::NotFound("依赖目标中没有所需组件".into()))?;
            state::valid_snapshot(&store.root, &target, component)
        })
        .await
    }

    pub async fn component_managed_keys(
        &self,
        kind: DependencyTargetKind,
        id: &str,
    ) -> Result<Vec<ToolKey>> {
        let id = id.to_owned();
        self.work(move |store| {
            let target = store.resolve(DependencyTarget {
                kind,
                id: id.clone(),
            })?;
            let state = state::load(&store.root, &target)?;
            let component = target
                .components
                .iter()
                .find(|component| component.id == id && component.kind == kind)
                .ok_or_else(|| Error::NotFound("依赖目标中没有所需组件".into()))?;
            let dependencies = state::component_dependencies(&target, component);
            Ok(target
                .manifest
                .dependencies
                .iter()
                .filter(|dependency| dependencies.contains(&dependency.id))
                .filter_map(|dependency| {
                    state
                        .selected
                        .get(&dependency.id)
                        .and_then(|selection| selection.key.clone())
                })
                .collect())
        })
        .await
    }
}

/// 同步配置资源路径查询入口；只读取本模块索引，旧部署身份不匹配时不返回 overlay。
pub fn snapshot_for(
    root: &Path,
    kind: DependencyTargetKind,
    id: &str,
    deployment: &Path,
) -> Result<Option<PathBuf>> {
    state::snapshot_for(root, kind, id, deployment)
}

pub(super) fn check(cancel: &CancellationToken, deadline: Instant) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

pub(super) fn deadline(context: apk_domain::ExecutionContext) -> Instant {
    context
        .deadline
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(120))
}

pub(super) fn repository_check(
    cancel: &CancellationToken,
    deadline: Instant,
) -> deviceforge_tool_repository::Result<()> {
    if cancel.is_cancelled() {
        Err(deviceforge_tool_repository::Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(deviceforge_tool_repository::Error::Timeout)
    } else {
        Ok(())
    }
}

pub(super) fn repository_error(error: deviceforge_tool_repository::Error) -> Error {
    use deviceforge_tool_repository::Error as Shared;
    match error {
        Shared::Busy | Shared::InUse => {
            Error::Conflict("共享工具仓库繁忙或仍被引用，请稍后重试".into())
        }
        Shared::Invalid(message) => Error::Invalid(message.into()),
        Shared::TooLarge => Error::TooLarge,
        Shared::Cancelled => Error::Cancelled,
        Shared::Timeout => Error::Timeout,
        Shared::Io(_) => Error::Storage("共享工具仓库文件操作失败".into()),
    }
}
