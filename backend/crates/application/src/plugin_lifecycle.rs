//! 通用进程插件生命周期，部署访问经领域端口，不依赖具体基础设施。
use crate::{Application, registry::Prepared};
use apk_domain::{Error, Result, plugins::*};
use deviceforge_observability::LogContext;
use std::future::Future;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct PluginService {
    app: Arc<Application>,
    catalog: Arc<dyn PluginCatalog>,
    protected: HashSet<String>,
    changes: Mutex<()>,
    admission: std::sync::Mutex<()>,
    pending: Arc<Semaphore>,
    closed: CancellationToken,
    tracker: TaskTracker,
}
impl PluginService {
    pub fn new(
        app: Arc<Application>,
        catalog: Arc<dyn PluginCatalog>,
        protected: HashSet<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            catalog,
            protected,
            changes: Mutex::new(()),
            admission: std::sync::Mutex::new(()),
            pending: Arc::new(Semaphore::new(2)),
            closed: CancellationToken::new(),
            tracker: TaskTracker::new(),
        })
    }
    /// 只在监听启动前装配初始贡献；运行中管理统一使用 load/unload。
    pub async fn seed(&self, plugin: PluginContribution) -> Result<PluginInfo> {
        let _change = self.changes.lock().await;
        let mut info = self.app.install_plugin(plugin).await?;
        info.protected = self.protected.contains(&info.id);
        Ok(info)
    }
    pub fn list(&self) -> Vec<PluginInfo> {
        self.app
            .registry
            .plugins()
            .into_iter()
            .map(|mut plugin| {
                plugin.protected = self.protected.contains(&plugin.id);
                plugin
            })
            .collect()
    }
    pub async fn load(self: &Arc<Self>, id: String) -> Result<PluginInfo> {
        self.change(id, true).await
    }
    pub async fn unload(self: &Arc<Self>, id: String) -> Result<PluginInfo> {
        self.change(id, false).await
    }
    async fn change(self: &Arc<Self>, id: String, loading: bool) -> Result<PluginInfo> {
        plugin_id(&id)?;
        self.serialized(move |service| async move {
            tracing::info!(plugin_id = %id, loading, "插件生命周期变更开始");
            let result = async {
                if loading {
                    let plugin = service.catalog.load(&id).await?;
                    if plugin.id != id {
                        return Err(Error::Invalid("部署插件 ID 与请求不符".into()));
                    }
                    service.app.install_plugin(plugin).await
                } else if service.protected.contains(&id) {
                    Err(Error::Conflict(
                        "插件被启动配置中的长期性能探针引用，不能运行中卸载".into(),
                    ))
                } else {
                    service.app.uninstall_plugin(id.clone()).await
                }
            }
            .await;
            let code = result.as_ref().err().map(Error::code).unwrap_or("ok");
            tracing::info!(plugin_id = %id, loading, code, "插件生命周期变更结束");
            result.map(|mut info| {
                info.protected = service.protected.contains(&id);
                info
            })
        })
        .await
    }

    /// 部署删除复用管理队列；调用方取消等待不会释放进行中的串行门禁。
    pub(crate) async fn serialized<T, F, Fut>(self: &Arc<Self>, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T>> + Send + 'static,
    {
        let task = {
            let _admission = self
                .admission
                .lock()
                .map_err(|_| Error::Storage("插件管理准入异常".into()))?;
            if self.closed.is_cancelled() {
                return Err(Error::Conflict("插件管理服务正在停止".into()));
            }
            let permit = self
                .pending
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::Conflict("插件管理工作已达到上限".into()))?;
            let service = self.clone();
            self.tracker.spawn(LogContext::propagate(async move {
                let _permit = permit;
                let _change = service.changes.lock().await;
                if service.closed.is_cancelled() {
                    return Err(Error::Conflict("插件管理服务正在停止".into()));
                }
                work(service.clone()).await
            }))
        };
        task.await
            .map_err(|_| Error::Dependency("插件生命周期工作异常".into()))?
    }
    pub fn close(&self) {
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.closed.cancel();
        self.tracker.close();
    }
    pub async fn wait(&self) {
        self.tracker.wait().await;
    }
}

impl Application {
    async fn install_plugin(self: &Arc<Self>, plugin: PluginContribution) -> Result<PluginInfo> {
        let app = self.clone();
        self.blocking(move || {
            let prepared = Prepared::new_with_bindings(plugin, &app.registry.1)?;
            let active = app
                .active
                .lock()
                .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
            if !active.accepting {
                return Err(Error::Conflict("服务正在停止接收贡献".into()));
            }
            app.registry.publish(prepared)
        })
        .await
    }
    async fn uninstall_plugin(self: &Arc<Self>, id: String) -> Result<PluginInfo> {
        let app = self.clone();
        let owner = self
            .blocking(move || {
                let _active = app
                    .active
                    .lock()
                    .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
                app.registry.detach(&id)
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(10), owner.tracker.wait())
            .await
            .map_err(|_| Error::Timeout)?;
        self.registry.finish(&owner)
    }
}
