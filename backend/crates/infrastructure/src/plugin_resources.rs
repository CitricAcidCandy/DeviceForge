//! 受限校验与真实进程租约；活动资源和已退出调用的外部债务分别有界。
use apk_domain::{Error, Result};
use apk_plugin_sdk::resources::ManagedResources;
use deviceforge_tool_repository::{ReadLease, Repository};
use std::{
    path::Path,
    sync::{Arc, OnceLock, atomic::AtomicBool},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
mod recovery;

pub(crate) use recovery::{confirm_recovery, recovery_ready};

struct ValidationPool {
    workers: Arc<Semaphore>,
    waiters: Arc<Semaphore>,
}
impl ValidationPool {
    fn new() -> Self {
        Self {
            workers: Arc::new(Semaphore::new(2)),
            waiters: Arc::new(Semaphore::new(8)),
        }
    }

    async fn acquire(
        &self,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<OwnedSemaphorePermit> {
        crate::execution_deadline::check(cancel, Some(deadline))?;
        let waiting = self
            .waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("工具资源校验等待队列已满".into()))?;
        let permit = crate::execution_deadline::run(cancel, Some(deadline), async {
            self.workers
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Error::Conflict("工具资源校验工作池正在关闭".into()))
        })
        .await?;
        drop(waiting);
        Ok(permit)
    }

    async fn work<T: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        deadline: Instant,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self.acquire(cancel, deadline).await?;
        let work_cancel = cancel.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            crate::execution_deadline::check(&work_cancel, Some(deadline))?;
            work()
        });
        crate::execution_deadline::run(cancel, Some(deadline), async {
            task.await
                .map_err(|_| Error::Storage("工具资源校验工作异常".into()))?
        })
        .await
    }
}

fn validation_pool() -> &'static ValidationPool {
    static POOL: OnceLock<ValidationPool> = OnceLock::new();
    POOL.get_or_init(ValidationPool::new)
}

pub(crate) struct ToolLease {
    reader: Option<ReadLease>,
    recovery: recovery::Call,
    runtime: Option<String>,
}
impl ToolLease {
    fn new(reader: Option<ReadLease>, unresolved: &Arc<AtomicBool>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            reader,
            recovery: recovery::Call::register(unresolved)?,
            runtime: None,
        }))
    }
    pub(crate) fn executable<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.runtime.as_deref().unwrap_or(fallback)
    }

    pub(crate) fn retain(&self) {
        self.recovery.retain();
    }

    /// 记录真实退出；资源持有者结束后释放仓库锁，不宣告外部债务已清理。
    pub(crate) fn process_exited(&self) {
        self.recovery.process_exited();
    }

    pub(crate) fn process_lease(self: &Arc<Self>) -> Arc<recovery::ProcessLease> {
        Arc::new(recovery::ProcessLease(self.clone()))
    }
}
impl Drop for ToolLease {
    fn drop(&mut self) {
        self.recovery.release(self.reader.take());
    }
}
fn shared_error(error: deviceforge_tool_repository::Error) -> Error {
    use deviceforge_tool_repository::Error as Shared;
    match error {
        Shared::Busy | Shared::InUse => Error::Conflict("共享工具正在变更".into()),
        Shared::Timeout => Error::Timeout,
        Shared::Cancelled => Error::Cancelled,
        Shared::TooLarge => Error::TooLarge,
        Shared::Invalid(message) => Error::Invalid(message.into()),
        Shared::Io(_) => Error::Storage("共享工具资源不可访问".into()),
    }
}
pub(crate) async fn acquire(
    path: Option<&Path>,
    cancel: &CancellationToken,
    deadline: Instant,
    unresolved: &Arc<AtomicBool>,
) -> Result<Arc<ToolLease>> {
    crate::execution_deadline::check(cancel, Some(deadline))?;
    let Some(path) = path else {
        return ToolLease::new(None, unresolved);
    };
    let path = path.to_owned();
    let work_cancel = cancel.clone();
    let unresolved = unresolved.clone();
    validation_pool()
        .work(cancel, deadline, move || {
            let check = || crate::execution_deadline::check(&work_cancel, Some(deadline));
            check()?;
            let resources = ManagedResources::read(&path)
                .map_err(|_| Error::Invalid("托管资源描述无效".into()))?;
            let runtime = resources
                .runtime
                .as_ref()
                .map(|runtime| {
                    resources
                        .entry(&runtime.id, &runtime.entry)
                        .map(|path| path.to_string_lossy().into_owned())
                        .map_err(|_| Error::Dependency("脚本运行时入口尚未就绪".into()))
                })
                .transpose()?;
            for (id, tool) in &resources.tools {
                if resources
                    .managed_tools
                    .as_ref()
                    .is_some_and(|managed| !managed.contains_key(id))
                {
                    for entry in tool.entries.values() {
                        check()?;
                        if !entry.is_file() {
                            return Err(Error::Dependency(
                                "外部依赖工具入口已失效，请重新检测".into(),
                            ));
                        }
                    }
                }
            }
            let has_managed = resources
                .managed_tools
                .as_ref()
                .map_or(!resources.tools.is_empty(), |managed| !managed.is_empty());
            // 供应插件本身没有工具绑定，不得先占读锁再请求仓库写锁。
            let reader = match (resources.repository, has_managed) {
                (Some(descriptor), true) => {
                    let repository = Repository::open(&descriptor.root).map_err(shared_error)?;
                    let reader = repository.read().map_err(shared_error)?;
                    for (id, tool) in resources.tools {
                        let package_version = match &resources.managed_tools {
                            Some(managed) => match managed.get(&id) {
                                Some(version) => version,
                                None => continue,
                            },
                            None => &tool.version,
                        };
                        if tool.entries.is_empty() {
                            return Err(Error::Invalid("资源工具缺少仓库入口".into()));
                        }
                        for entry in tool.entries.values() {
                            let key = reader
                                .verify_entry(entry, &|| {
                                    check().map_err(|error| match error {
                                        Error::Cancelled => {
                                            deviceforge_tool_repository::Error::Cancelled
                                        }
                                        _ => deviceforge_tool_repository::Error::Timeout,
                                    })
                                })
                                .map_err(shared_error)?;
                            if key.id != id
                                || key.version != *package_version
                                || key.platform != tool.platform
                            {
                                return Err(Error::Invalid("资源工具身份与仓库入口不符".into()));
                            }
                        }
                    }
                    Some(reader)
                }
                _ => None,
            };
            check()?;
            Ok(Arc::new(ToolLease {
                reader,
                recovery: recovery::Call::register(&unresolved)?,
                runtime,
            }))
        })
        .await
}

#[cfg(test)]
#[path = "plugin_resources_tests.rs"]
mod tests;
