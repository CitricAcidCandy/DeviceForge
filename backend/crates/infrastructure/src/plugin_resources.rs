//! 受限阻塞校验与真实进程工具租约；未确认的外部资源保守保留到宿主退出。
use apk_domain::{Error, Result};
use apk_plugin_sdk::resources::ManagedResources;
use deviceforge_tool_repository::{ReadLease, Repository};
use std::{
    path::Path,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

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
    retained: AtomicBool,
}
impl ToolLease {
    pub(crate) fn retain(&self) {
        self.retained.store(true, Ordering::Release);
    }
}
impl Drop for ToolLease {
    fn drop(&mut self) {
        if self.retained.load(Ordering::Acquire)
            && let Some(reader) = self.reader.take()
        {
            // 外部资源退出无法证明，不能用直接子进程退出替代工具使用结束。
            std::mem::forget(reader);
        }
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
) -> Result<Arc<ToolLease>> {
    crate::execution_deadline::check(cancel, Some(deadline))?;
    let Some(path) = path else {
        return Ok(Arc::new(ToolLease {
            reader: None,
            retained: AtomicBool::new(false),
        }));
    };
    let path = path.to_owned();
    let work_cancel = cancel.clone();
    validation_pool()
        .work(cancel, deadline, move || {
            let check = || crate::execution_deadline::check(&work_cancel, Some(deadline));
            check()?;
            let resources = ManagedResources::read(&path)
                .map_err(|_| Error::Invalid("托管资源描述无效".into()))?;
            // 供应插件本身没有工具绑定，不得先占读锁再请求仓库写锁。
            let reader = match (resources.repository, resources.tools.is_empty()) {
                (Some(descriptor), false) => {
                    let repository = Repository::open(&descriptor.root).map_err(shared_error)?;
                    let reader = repository.read().map_err(shared_error)?;
                    for (id, tool) in resources.tools {
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
                                || key.version != tool.version
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
                retained: AtomicBool::new(false),
            }))
        })
        .await
}

#[cfg(test)]
#[path = "plugin_resources_tests.rs"]
mod tests;
