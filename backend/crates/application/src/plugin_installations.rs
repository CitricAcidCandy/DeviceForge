//! 统一插件安装生命周期；归档和目录操作留给基础设施端口。
mod actions;
use crate::plugin_lifecycle::PluginService;
use apk_domain::{
    Error, Result, browser_configurations::BrowserConfigurationStore,
    plugin_configurations::PluginConfigurationStore, plugin_installations::*,
    plugin_packages::PackageKind, plugins::plugin_id,
};
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;
#[cfg(test)]
#[path = "plugin_installations_tests.rs"]
mod tests;

pub struct InstallationService {
    store: Arc<dyn InstallationStore>,
    plugins: Arc<PluginService>,
    server_configurations: Arc<dyn PluginConfigurationStore>,
    browser_configurations: Arc<dyn BrowserConfigurationStore>,
    dependencies: OnceLock<Arc<crate::plugin_dependencies::DependencyService>>,
}

impl InstallationService {
    pub fn new(
        store: Arc<dyn InstallationStore>,
        plugins: Arc<PluginService>,
        server_configurations: Arc<dyn PluginConfigurationStore>,
        browser_configurations: Arc<dyn BrowserConfigurationStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            plugins,
            server_configurations,
            browser_configurations,
            dependencies: OnceLock::new(),
        })
    }
    pub fn bind_dependencies(
        &self,
        service: Arc<crate::plugin_dependencies::DependencyService>,
    ) -> Result<()> {
        self.dependencies
            .set(service)
            .map_err(|_| Error::Conflict("依赖服务已绑定".into()))
    }

    async fn prepare_dependencies(
        &self,
        release: &InstalledRelease,
        download_missing: bool,
        cancel: CancellationToken,
        mut context: apk_domain::ExecutionContext,
        progress: Arc<dyn apk_domain::ProgressReporter>,
    ) -> Result<bool> {
        let Some(service) = self.dependencies.get() else {
            return Ok(true);
        };
        use apk_domain::plugin_dependencies::*;
        let target = DependencyTarget {
            kind: DependencyTargetKind::Release,
            id: release.id.clone(),
        };
        if context.deadline.is_none() {
            context.deadline = Some(
                std::time::Instant::now()
                    + std::time::Duration::from_secs(if download_missing { 3_600 } else { 120 }),
            );
        }
        let result = if download_missing {
            service.ensure(target, cancel, context, progress).await?
        } else {
            let current = service.get(target.clone()).await?;
            service
                .scan(
                    DependencyRequest {
                        target,
                        expected_revision: current.revision,
                        dependency_ids: Vec::new(),
                    },
                    cancel,
                    context,
                    progress,
                )
                .await?
        };
        Ok(result.ready)
    }
    pub async fn list(&self) -> Result<Vec<InstalledRelease>> {
        self.store.list().await
    }
    pub async fn get(&self, id: &str) -> Result<InstalledRelease> {
        plugin_id(id)?;
        self.store.get(id).await
    }
    pub async fn plan(&self, source: InstallSource) -> Result<InstallationPlan> {
        self.store.plan(source).await
    }

    pub async fn install(
        self: &Arc<Self>,
        source: InstallSource,
        expected_revision: Option<String>,
    ) -> Result<InstalledRelease> {
        self.install_cancelled(source, expected_revision, CancellationToken::new())
            .await
    }
    pub async fn install_cancelled(
        self: &Arc<Self>,
        source: InstallSource,
        expected_revision: Option<String>,
        cancel: CancellationToken,
    ) -> Result<InstalledRelease> {
        self.install_with_progress(
            source,
            expected_revision,
            cancel,
            Arc::new(apk_domain::NoProgress),
        )
        .await
    }
    pub async fn install_with_progress(
        self: &Arc<Self>,
        source: InstallSource,
        expected_revision: Option<String>,
        cancel: CancellationToken,
        progress: Arc<dyn apk_domain::ProgressReporter>,
    ) -> Result<InstalledRelease> {
        self.install_with_execution(
            source,
            expected_revision,
            cancel,
            progress,
            Default::default(),
        )
        .await
    }
    pub async fn install_with_execution(
        self: &Arc<Self>,
        source: InstallSource,
        expected_revision: Option<String>,
        cancel: CancellationToken,
        progress: Arc<dyn apk_domain::ProgressReporter>,
        context: apk_domain::ExecutionContext,
    ) -> Result<InstalledRelease> {
        if let Some(expected) = &expected_revision {
            validate_release_digest(expected)?;
        }
        progress
            .report(apk_domain::JobProgress::stage(
                apk_domain::JobStage::Preparing,
            ))
            .await?;
        let prepared = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            prepared = self.store.prepare_with_progress(source, progress.clone()) => prepared?,
        };
        let service = self.clone();
        let commit_cancel = cancel.clone();
        let commit_progress = progress.clone();
        let (installed, old, old_loaded) = self
            .plugins
            .serialized(move |plugins| async move {
                if commit_cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                commit_progress
                    .report(apk_domain::JobProgress::stage(
                        apk_domain::JobStage::Deploying,
                    ))
                    .await?;
                plugins
                    .validate_installation_operations(prepared.operations().to_vec())
                    .await?;
                let target_id = prepared.info().id.clone();
                let old = match service.store.get(&target_id).await {
                    Ok(value) => Some(value),
                    Err(Error::NotFound(_)) => None,
                    Err(error) => return Err(error),
                };
                // 修订只匹配实际发布 ID，更新来源不能借另一发布的旧修订创建新 ID。
                if old.as_ref().map(|value| value.revision.as_str()) != expected_revision.as_deref()
                {
                    return Err(Error::Conflict(
                        "安装修订与目标发布不匹配，请刷新后重试".into(),
                    ));
                }
                if let Some(old) = &old {
                    service.require_recoverable(old)?;
                    service.require_clean_components(old).await?;
                }
                if commit_cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let old_loaded = service.loaded_components(old.as_ref());
                if let Some(old) = &old
                    && let Err(error) = service.unload(&plugins, old).await
                {
                    if service
                        .reload_components(&plugins, &old_loaded)
                        .await
                        .is_err()
                    {
                        return Err(service
                            .blocked(old, "unload_rollback", "旧组件撤销失败且重新加载未完成")
                            .await);
                    }
                    return Err(error);
                }
                // 提交开始后即使调用方离开，也持有生命周期门禁直到恢复稳定状态。
                let installed = match prepared.commit(expected_revision).await {
                    Ok(value) => value,
                    Err(error) => {
                        let current = service.store.get(&target_id).await;
                        if current.as_ref().is_ok_and(|current| {
                            current.status == InstallationStatus::RecoveryBlocked
                        }) {
                            return Err(error);
                        }
                        if service
                            .reload_components(&plugins, &old_loaded)
                            .await
                            .is_err()
                            && let Some(old) = &old
                        {
                            return Err(service
                                .blocked(
                                    old,
                                    "commit_rollback",
                                    "文件提交失败且旧组件重新加载未完成",
                                )
                                .await);
                        }
                        return Err(error);
                    }
                };
                Ok((installed, old, old_loaded))
            })
            .await?;
        // 工具下载不占全局生命周期锁，其他插件的启停和管理仍可继续。
        match self
            .prepare_dependencies(&installed, true, cancel.clone(), context, progress.clone())
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return self
                    .store
                    .dependencies_required(&installed.id, &installed.revision)
                    .await;
            }
            Err(error) => {
                self.store
                    .dependencies_required(&installed.id, &installed.revision)
                    .await?;
                return Err(error);
            }
        }
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                let current = service.current(&installed.id, &installed.revision).await?;
                service.require_recoverable(&current)?;
                let activation = async {
                    // 文件已提交，进度存储失败不能触发业务回退。
                    let _ = progress
                        .report(apk_domain::JobProgress::stage(
                            apk_domain::JobStage::Activating,
                        ))
                        .await;
                    if service.requires_configuration(&installed).await? {
                        return service
                            .store
                            .configuration_required(&installed.id, &installed.revision)
                            .await;
                    }
                    if current.enabled {
                        service.enable(&plugins, &installed).await
                    } else {
                        Ok(current.clone())
                    }
                }
                .await;
                match activation {
                    Ok(value) => {
                        let _ = progress
                            .report(apk_domain::JobProgress::stage(
                                apk_domain::JobStage::Complete,
                            ))
                            .await;
                        Ok(value)
                    }
                    Err(error) => {
                        if matches!(
                            service.store.get(&installed.id).await?.status,
                            InstallationStatus::RecoveryBlocked
                                | InstallationStatus::DependenciesRequired
                        ) {
                            return Err(error);
                        }
                        if service.unload(&plugins, &installed).await.is_err() {
                            return Err(service
                                .blocked(
                                    &installed,
                                    "activation_cleanup",
                                    "激活失败且新组件清理未完成",
                                )
                                .await);
                        }
                        if old.is_some() {
                            if service
                                .store
                                .restore_previous(&installed.id, &installed.revision)
                                .await
                                .is_err()
                            {
                                return Err(service
                                    .blocked_current(
                                        &installed.id,
                                        "activation_rollback",
                                        "激活失败且上版文件恢复未完成",
                                    )
                                    .await);
                            }
                            if service
                                .reload_components(&plugins, &old_loaded)
                                .await
                                .is_err()
                            {
                                return Err(service
                                    .blocked_current(
                                        &installed.id,
                                        "activation_reload",
                                        "上版文件已恢复，但旧组件重新加载未完成",
                                    )
                                    .await);
                            }
                        } else {
                            // 未激活的安装可直接回滚；失败时保留原启用意图供恢复状态展示。
                            if service
                                .store
                                .delete(&installed.id, &installed.revision)
                                .await
                                .is_err()
                            {
                                return Err(service
                                    .blocked_current(
                                        &installed.id,
                                        "activation_rollback",
                                        "激活失败且新安装记录清理未完成",
                                    )
                                    .await);
                            }
                        }
                        Err(error)
                    }
                }
            })
            .await
    }

    pub async fn set_enabled(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        enabled: bool,
    ) -> Result<InstalledRelease> {
        self.set_enabled_cancelled(id, expected_revision, enabled, CancellationToken::new())
            .await
    }

    pub async fn set_enabled_cancelled(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        enabled: bool,
        cancel: CancellationToken,
    ) -> Result<InstalledRelease> {
        plugin_id(&id)?;
        validate_release_digest(&expected_revision)?;
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let release = service.current(&id, &expected_revision).await?;
                service.require_recoverable(&release)?;
                service.require_clean_components(&release).await?;
                if enabled {
                    if !service
                        .prepare_dependencies(
                            &release,
                            false,
                            cancel.clone(),
                            Default::default(),
                            Arc::new(apk_domain::NoProgress),
                        )
                        .await?
                    {
                        return service
                            .store
                            .dependencies_required(&id, &expected_revision)
                            .await;
                    }
                    if service.requires_configuration(&release).await? {
                        let previous = service.loaded_components(Some(&release));
                        if let Err(error) = service.unload(&plugins, &release).await {
                            if service
                                .reload_components(&plugins, &previous)
                                .await
                                .is_err()
                            {
                                return Err(service
                                    .blocked(
                                        &release,
                                        "configuration_rollback",
                                        "必填配置缺失，组件撤销失败且重新加载未完成",
                                    )
                                    .await);
                            }
                            return Err(error);
                        }
                        return match service
                            .store
                            .configuration_required(&id, &expected_revision)
                            .await
                        {
                            Ok(value) => Ok(value),
                            Err(error) => {
                                if service
                                    .reload_components(&plugins, &previous)
                                    .await
                                    .is_err()
                                {
                                    return Err(service
                                        .blocked(
                                            &release,
                                            "configuration_rollback",
                                            "待配置状态写入失败且旧组件重新加载未完成",
                                        )
                                        .await);
                                }
                                Err(error)
                            }
                        };
                    }
                    service.enable(&plugins, &release).await
                } else {
                    let previous = service.loaded_components(Some(&release));
                    if let Err(error) = service.unload(&plugins, &release).await {
                        if service
                            .reload_components(&plugins, &previous)
                            .await
                            .is_err()
                        {
                            return Err(service
                                .blocked(
                                    &release,
                                    "disable_rollback",
                                    "停用失败且旧组件重新加载未完成",
                                )
                                .await);
                        }
                        return Err(error);
                    }
                    match service
                        .store
                        .set_enabled(&id, &expected_revision, false)
                        .await
                    {
                        Ok(value) => Ok(value),
                        Err(error) => {
                            if service
                                .reload_components(&plugins, &previous)
                                .await
                                .is_err()
                            {
                                return Err(service
                                    .blocked(
                                        &release,
                                        "disable_rollback",
                                        "停用状态写入失败且旧组件重新加载未完成",
                                    )
                                    .await);
                            }
                            Err(error)
                        }
                    }
                }
            })
            .await
    }

    pub async fn delete(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
    ) -> Result<InstalledRelease> {
        self.delete_cancelled(id, expected_revision, CancellationToken::new())
            .await
    }

    pub async fn delete_cancelled(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        cancel: CancellationToken,
    ) -> Result<InstalledRelease> {
        plugin_id(&id)?;
        validate_release_digest(&expected_revision)?;
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let release = service.current(&id, &expected_revision).await?;
                service.require_recoverable(&release)?;
                service.require_clean_components(&release).await?;
                if release.enabled {
                    return Err(Error::Conflict("启用中的发布不能删除，请先停用".into()));
                }
                service.unload(&plugins, &release).await?;
                let record = service.store.delete(&id, &expected_revision).await?;
                if let Some(dependencies) = service.dependencies.get() {
                    dependencies
                        .forget(apk_domain::plugin_dependencies::DependencyTarget {
                            kind: apk_domain::plugin_dependencies::DependencyTargetKind::Release,
                            id,
                        })
                        .await?;
                }
                Ok(record)
            })
            .await
    }

    /// 启动时恢复持久化启用状态；缺少账号输入时保持明确的待配置状态。
    pub async fn restore(self: &Arc<Self>) -> Result<()> {
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                for release in service.store.list().await? {
                    if !release.enabled || release.requires_recovery() {
                        continue;
                    }
                    let ready = service.prepare_dependencies(&release, false, CancellationToken::new(), Default::default(), Arc::new(apk_domain::NoProgress)).await;
                    if !ready.as_ref().is_ok_and(|ready| *ready) {
                        if let Err(error) = ready {
                            tracing::warn!(release_id = %release.id, error = %error, "单个发布依赖恢复失败，继续恢复其他发布");
                        }
                        service.store.dependencies_required(&release.id, &release.revision).await?;
                        continue;
                    }
                    if service.requires_configuration(&release).await? {
                        service
                            .store
                            .configuration_required(&release.id, &release.revision)
                            .await?;
                    } else if service.enable(&plugins, &release).await.is_err() {
                        let current = service.store.get(&release.id).await?;
                        if current.status != InstallationStatus::RecoveryBlocked {
                            // 恢复失败可以隔离到单个发布，持久化失败本身必须继续上报。
                            service
                                .store
                                .recovery_blocked(
                                    &current.id,
                                    &current.revision,
                                    "startup_activation",
                                    "启动时无法恢复已启用组件",
                                )
                                .await?;
                        }
                    }
                }
                Ok(())
            })
            .await
    }
    pub async fn reconcile_startup(self: &Arc<Self>) -> Result<()> {
        self.restore().await
    }
    /// 在生命周期锁中重新读取真实运行集合，删除请求不能自行声明资源为空闲。
    pub async fn cleanup_resources(
        self: &Arc<Self>,
        dry_run: bool,
    ) -> Result<ResourceCleanupReport> {
        self.cleanup_resources_cancelled(dry_run, CancellationToken::new())
            .await
    }
    pub async fn cleanup_resources_cancelled(
        self: &Arc<Self>,
        dry_run: bool,
        cancel: CancellationToken,
    ) -> Result<ResourceCleanupReport> {
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let running = plugins.list().into_iter().map(|plugin| plugin.id).collect();
                service.store.cleanup_resources(dry_run, running).await
            })
            .await
    }
    pub async fn asset(
        &self,
        component_id: &str,
        revision: &str,
        path: &str,
    ) -> Result<apk_domain::plugin_packages::PackageAsset> {
        plugin_id(component_id)?;
        validate_release_digest(revision)?;
        self.store.asset(component_id, revision, path).await
    }

    async fn current(&self, id: &str, revision: &str) -> Result<InstalledRelease> {
        let release = self.store.get(id).await?;
        if release.revision != revision {
            return Err(Error::Conflict("发布修订已变化，请刷新后重试".into()));
        }
        Ok(release)
    }
    fn require_recoverable(&self, release: &InstalledRelease) -> Result<()> {
        if release.requires_recovery() {
            Err(Error::Conflict("发布恢复受阻，请先修复记录中的错误".into()))
        } else {
            Ok(())
        }
    }
    async fn require_clean_components(&self, release: &InstalledRelease) -> Result<()> {
        let loaded = self.plugins.list();
        if release.components.iter().any(|component| {
            component.kind == PackageKind::Server
                && loaded
                    .iter()
                    .any(|plugin| plugin.id == component.id && plugin.cleanup_failed)
        }) {
            tracing::warn!(release_id = %release.id, "组件有历史清理警告，继续独立安装操作");
        }
        Ok(())
    }
    async fn blocked_current(&self, id: &str, phase: &str, reason: &str) -> Error {
        match self.store.get(id).await {
            Ok(release) => self.blocked(&release, phase, reason).await,
            Err(_) => Error::Storage(format!("{reason}；恢复受阻状态也无法读取")),
        }
    }
    async fn blocked(&self, release: &InstalledRelease, phase: &str, reason: &str) -> Error {
        match self
            .store
            .recovery_blocked(&release.id, &release.revision, phase, reason)
            .await
        {
            Ok(_) => Error::Storage(format!("{reason}；已标记恢复受阻")),
            Err(_) => Error::Storage(format!("{reason}；恢复受阻状态持久化也失败")),
        }
    }
    fn loaded_components(&self, release: Option<&InstalledRelease>) -> Vec<String> {
        let loaded = self.plugins.list();
        release
            .into_iter()
            .flat_map(|release| &release.components)
            .filter(|component| {
                component.kind == PackageKind::Server
                    && loaded.iter().any(|plugin| plugin.id == component.id)
            })
            .map(|component| component.id.clone())
            .collect()
    }
    async fn unload(&self, plugins: &PluginService, release: &InstalledRelease) -> Result<()> {
        for component in release
            .components
            .iter()
            .filter(|component| component.kind == PackageKind::Server)
        {
            plugins.unload_idle_serialized(&component.id).await?;
        }
        Ok(())
    }
    async fn reload_components(&self, plugins: &PluginService, ids: &[String]) -> Result<()> {
        for id in ids {
            if !plugins.list().iter().any(|plugin| &plugin.id == id) {
                plugins.load_serialized(id).await?;
            }
        }
        Ok(())
    }
    async fn enable(
        &self,
        plugins: &PluginService,
        release: &InstalledRelease,
    ) -> Result<InstalledRelease> {
        self.require_recoverable(release)?;
        self.require_clean_components(release).await?;
        let mut loaded = Vec::new();
        let outcome = async {
            for component in release
                .components
                .iter()
                .filter(|component| component.kind == PackageKind::Server)
            {
                if !plugins
                    .list()
                    .iter()
                    .any(|plugin| plugin.id == component.id)
                {
                    plugins.load_serialized(&component.id).await?;
                    loaded.push(component.id.clone());
                }
            }
            let enabled = self
                .store
                .set_enabled(&release.id, &release.revision, true)
                .await?;
            self.store
                .record_successful_activation(&release.id, &release.revision)
                .await?;
            Ok(enabled)
        }
        .await;
        if outcome.is_err() {
            for id in loaded.into_iter().rev() {
                if plugins.unload_idle_serialized(&id).await.is_err() {
                    return Err(self
                        .blocked(release, "enable_cleanup", "启用失败且已加载组件清理未完成")
                        .await);
                }
            }
        }
        outcome
    }
    async fn requires_configuration(&self, release: &InstalledRelease) -> Result<bool> {
        for requirement in release
            .requirements
            .iter()
            .filter(|requirement| requirement.required)
        {
            let component = release
                .components
                .iter()
                .find(|component| component.id == requirement.component_id)
                .ok_or_else(|| Error::Invalid("发布输入声明引用未知组件".into()))?;
            let pointers: Vec<String> = std::iter::once(&requirement.config_pointer)
                .chain(&requirement.any_of)
                .cloned()
                .collect();
            let values = match component.kind {
                PackageKind::Server => match self
                    .server_configurations
                    .requirements_configured(&component.id, &pointers)
                    .await
                {
                    Ok(true) => continue,
                    Ok(false) | Err(Error::NotFound(_)) => None,
                    Err(error) => return Err(error),
                },
                PackageKind::Browser => self
                    .browser_configurations
                    .get(&component.id)
                    .await?
                    .map(|configuration| configuration.values),
            };
            if !values.as_ref().is_some_and(|values| {
                pointers
                    .iter()
                    .any(|pointer| values.pointer(pointer).is_some_and(configured))
            }) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn configured(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::String(value) => !value.trim().is_empty(),
        serde_json::Value::Array(value) => !value.is_empty(),
        serde_json::Value::Object(value) => !value.is_empty(),
        _ => true,
    }
}
