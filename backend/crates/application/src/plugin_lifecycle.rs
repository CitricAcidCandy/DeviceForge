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
    installations:
        std::sync::OnceLock<Arc<dyn apk_domain::plugin_installations::InstallationStore>>,
    dependencies:
        std::sync::OnceLock<std::sync::Weak<crate::plugin_dependencies::DependencyService>>,
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
            installations: std::sync::OnceLock::new(),
            dependencies: std::sync::OnceLock::new(),
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
    /// 调试重载与普通管理共用串行门禁，代次核验、排空和发布之间不插入另一项管理操作。
    pub async fn reload_expected(
        self: &Arc<Self>,
        id: String,
        generation: String,
    ) -> Result<PluginInfo> {
        self.reload_expected_with_execution(
            id,
            generation,
            self.closed.child_token(),
            apk_domain::ExecutionContext {
                deadline: Some(std::time::Instant::now() + Duration::from_secs(30)),
            },
        )
        .await
    }
    /// 截止点包含串行排队；已经开始的撤销继续有界收尾，取消后不再发布新代。
    pub async fn reload_expected_with_execution(
        self: &Arc<Self>,
        id: String,
        generation: String,
        cancel: CancellationToken,
        context: apk_domain::ExecutionContext,
    ) -> Result<PluginInfo> {
        plugin_id(&id)?;
        self.serialized(move |service| async move {
            let check = || {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                if context
                    .deadline
                    .is_some_and(|deadline| deadline <= std::time::Instant::now())
                {
                    return Err(Error::Timeout);
                }
                Ok(())
            };
            check()?;
            let current = service
                .list()
                .into_iter()
                .find(|plugin| plugin.id == id)
                .ok_or_else(|| Error::Conflict("重载目标已卸载，请重新选择当前插件".into()))?;
            if current.generation != generation {
                return Err(Error::Conflict("插件代次已变化，本次未重载新实例".into()));
            }
            if service.protected.contains(&id) {
                return Err(Error::Conflict(
                    "当前插件被长期来源引用，不能在运行中重载".into(),
                ));
            }
            if let Some(store) = service.installations.get()
                && store.list().await?.iter().any(|release| {
                    release
                        .components
                        .iter()
                        .any(|component| component.id == id)
                })
            {
                return Err(Error::Conflict(
                    "该组件属于完整功能，请通过原完整功能管理入口重载，不能拆开变更所属组件".into(),
                ));
            }
            service
                .require_dependencies_with_execution(&id, cancel.clone(), context)
                .await?;
            check()?;
            let plugin = service.catalog.load(&id).await?;
            check()?;
            if plugin.id != id {
                return Err(Error::Invalid("部署插件 ID 与重载目标不一致".into()));
            }
            // 先验证新贡献；验证失败时旧插件继续运行，不先把业务卸载掉。
            let app = service.app.clone();
            let target = id.clone();
            let preparing_cancel = cancel.clone();
            let deadline = context.deadline.map(Into::into);
            let prepared = service
                .app
                .blocking_until(Some(preparing_cancel.clone()), deadline, move || {
                    let prepared = Prepared::new_with_bindings(plugin, &app.registry.1)?;
                    crate::operation_budget::check(deadline, Some(&preparing_cancel))?;
                    app.registry.validate_replacement(&target, &prepared)?;
                    Ok(prepared)
                })
                .await?;
            check()?;
            service.app.uninstall_plugin(id.clone()).await?;
            check()?;
            let app = service.app.clone();
            let publishing_cancel = cancel.clone();
            service
                .app
                .blocking_until(Some(publishing_cancel.clone()), deadline, move || {
                    let active = app
                        .active
                        .lock()
                        .map_err(|_| Error::Storage("插件重载准入状态异常".into()))?;
                    crate::operation_budget::check(deadline, Some(&publishing_cancel))?;
                    if !active.accepting {
                        return Err(Error::Conflict(
                            "服务正在停止，旧插件已撤销，未发布新实例".into(),
                        ));
                    }
                    app.registry.publish(prepared)
                })
                .await
        })
        .await
    }
    pub fn bind_installations(
        &self,
        store: Arc<dyn apk_domain::plugin_installations::InstallationStore>,
    ) -> Result<()> {
        self.installations
            .set(store)
            .map_err(|_| Error::Conflict("插件安装存储已绑定".into()))
    }
    pub fn bind_dependencies(
        &self,
        service: &Arc<crate::plugin_dependencies::DependencyService>,
    ) -> Result<()> {
        self.dependencies
            .set(Arc::downgrade(service))
            .map_err(|_| Error::Conflict("插件依赖服务已绑定".into()))
    }
    async fn require_dependencies(&self, id: &str) -> Result<()> {
        self.require_dependencies_with_execution(
            id,
            self.closed.clone(),
            apk_domain::ExecutionContext {
                deadline: Some(std::time::Instant::now() + Duration::from_secs(120)),
            },
        )
        .await
    }
    async fn require_dependencies_with_execution(
        &self,
        id: &str,
        cancel: CancellationToken,
        context: apk_domain::ExecutionContext,
    ) -> Result<()> {
        let Some(service) = self.dependencies.get().and_then(std::sync::Weak::upgrade) else {
            return Ok(());
        };
        use apk_domain::plugin_dependencies::*;
        let target = DependencyTarget {
            kind: DependencyTargetKind::Server,
            id: id.into(),
        };
        let current = service.get(target.clone()).await?;
        let scanned = service
            .scan(
                DependencyRequest {
                    target,
                    expected_revision: current.revision,
                    dependency_ids: Vec::new(),
                },
                cancel,
                context,
                Arc::new(apk_domain::NoProgress),
            )
            .await?;
        if !scanned.ready {
            return Err(Error::Dependency(
                "插件依赖尚未就绪，请在插件管理页安装缺失依赖".into(),
            ));
        }
        Ok(())
    }
    /// 仅由已持有 serialized 门禁的安装用例调用，避免再次取得同一管理锁。
    pub(crate) async fn load_serialized(&self, id: &str) -> Result<PluginInfo> {
        plugin_id(id)?;
        self.require_dependencies(id).await?;
        let plugin = self.catalog.load(id).await?;
        if plugin.id != id {
            return Err(Error::Invalid("部署插件 ID 与请求不符".into()));
        }
        self.app.install_plugin(plugin).await
    }
    /// 整套事务已持有管理门禁；阻塞任务开始后等待其结束，不丢弃注册工作。
    pub(crate) async fn load_serialized_until(
        &self,
        id: &str,
        context: apk_domain::ExecutionContext,
    ) -> Result<PluginInfo> {
        plugin_id(id)?;
        let deadline = context.deadline.map(Into::into);
        crate::operation_budget::check(deadline, Some(&self.closed))?;
        self.require_dependencies_with_execution(id, self.closed.clone(), context)
            .await?;
        crate::operation_budget::check(deadline, Some(&self.closed))?;
        let plugin = self.catalog.load(id).await?;
        crate::operation_budget::check(deadline, Some(&self.closed))?;
        if plugin.id != id {
            return Err(Error::Invalid("部署插件 ID 与请求不符".into()));
        }
        let app = self.app.clone();
        let cancel = self.closed.clone();
        self.app
            .blocking_until(Some(cancel.clone()), deadline, move || {
                let prepared = Prepared::new_with_bindings(plugin, &app.registry.1)?;
                let active = app
                    .active
                    .lock()
                    .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
                crate::operation_budget::check(deadline, Some(&cancel))?;
                if !active.accepting {
                    return Err(Error::Conflict("服务正在停止接收贡献".into()));
                }
                app.registry.publish(prepared)
            })
            .await
    }
    pub(crate) async fn validate_installation_operations(
        &self,
        operations: Vec<apk_domain::Operation>,
    ) -> Result<()> {
        self.app
            .blocking(move || crate::registration::validate_operations(&operations))
            .await
    }
    /// 更新与删除拒绝活动任务和未确认资源，不隐式取消正在工作的旧版。
    pub(crate) async fn unload_idle_serialized(&self, id: &str) -> Result<()> {
        if self.protected.contains(id) {
            return Err(Error::Conflict("组件被长期来源引用，不能变更部署".into()));
        }
        if !self.list().iter().any(|plugin| plugin.id == id) {
            return Ok(());
        }
        let app = self.app.clone();
        let id = id.to_owned();
        self.app
            .blocking(move || {
                let _active = app
                    .active
                    .lock()
                    .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
                let owner = app.registry.detach_if_idle(&id)?;
                app.registry.finish(&owner)?;
                Ok(())
            })
            .await
    }
    /// 继承整套操作原期限；只撤销当前无活动任务的组件，不等待另一套管理锁。
    pub(crate) async fn unload_idle_serialized_until(
        &self,
        id: &str,
        context: apk_domain::ExecutionContext,
    ) -> Result<()> {
        let deadline = context.deadline.map(Into::into);
        crate::operation_budget::check(deadline, Some(&self.closed))?;
        if self.protected.contains(id) {
            return Err(Error::Conflict("组件被长期来源引用，不能变更部署".into()));
        }
        if !self.list().iter().any(|plugin| plugin.id == id) {
            return Ok(());
        }
        let app = self.app.clone();
        let id = id.to_owned();
        let cancel = self.closed.clone();
        self.app
            .blocking_until(Some(cancel.clone()), deadline, move || {
                let _active = app
                    .active
                    .lock()
                    .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
                crate::operation_budget::check(deadline, Some(&cancel))?;
                let owner = app.registry.detach_if_idle(&id)?;
                app.registry.finish(&owner)?;
                Ok(())
            })
            .await
    }
    pub(crate) async fn apply_configuration(
        self: &Arc<Self>,
        store: Arc<dyn apk_domain::plugin_configurations::PluginConfigurationStore>,
        id: String,
        expected: u64,
    ) -> Result<apk_domain::plugin_configurations::PluginConfiguration> {
        self.serialized(move |service| async move {
            use apk_domain::plugin_configurations::ConfigurationApplyPolicy;
            let current = store.get(&id).await?;
            if current.revision != expected {
                return Err(Error::Conflict("配置修订已变化，请刷新后重试".into()));
            }
            if !current.compatible {
                return Err(Error::Conflict("配置与插件声明不兼容，不能应用".into()));
            }
            let definition = current
                .definition
                .as_ref()
                .ok_or_else(|| Error::Conflict("旧插件未声明统一配置".into()))?;
            if definition.apply_policy == ConfigurationApplyPolicy::PluginReload
                && service.list().iter().any(|owner| owner.id == id)
            {
                if service.protected.contains(&id) {
                    return Err(Error::Conflict("当前插件受保护，不能运行中重载配置".into()));
                }
                // 新部署先完整验证；随后原子拒绝活动任务并关闭旧代际准入。
                let plugin = service.catalog.load(&id).await?;
                let app = service.app.clone();
                let target = id.clone();
                service
                    .app
                    .blocking(move || {
                        let prepared = Prepared::new_with_bindings(plugin, &app.registry.1)?;
                        app.registry.validate_replacement(&target, &prepared)?;
                        let _active = app
                            .active
                            .lock()
                            .map_err(|_| Error::Storage("任务准入状态异常".into()))?;
                        if !_active.accepting {
                            return Err(Error::Conflict("服务正在停止，不能重载配置".into()));
                        }
                        let owner = app.registry.detach_if_idle(&target)?;
                        app.registry.finish(&owner)?;
                        app.registry.publish(prepared)
                    })
                    .await?;
            }
            // 加载只注册贡献，不运行插件；成功后切换调用读取的修订指针。
            store.mark_applied(&id, expected).await
        })
        .await
    }
    async fn change(self: &Arc<Self>, id: String, loading: bool) -> Result<PluginInfo> {
        plugin_id(&id)?;
        self.serialized(move |service| async move {
            if let Some(store) = service.installations.get()
                && store.list().await?.iter().any(|release| {
                    release
                        .components
                        .iter()
                        .any(|component| component.id == id)
                })
            {
                return Err(Error::Conflict(
                    "托管组件请通过统一发布启停，避免组件状态与发布状态分离".into(),
                ));
            }
            tracing::info!(plugin_id = %id, loading, "插件生命周期变更开始");
            let result = async {
                if loading {
                    service.require_dependencies(&id).await?;
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
