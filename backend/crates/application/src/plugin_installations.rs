//! 统一插件安装生命周期；归档和目录操作留给基础设施端口。
use crate::plugin_lifecycle::PluginService;
use apk_domain::{
    Error, Result, browser_configurations::BrowserConfigurationStore,
    plugin_configurations::PluginConfigurationStore, plugin_installations::*,
    plugin_packages::PackageKind, plugins::plugin_id,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
#[cfg(test)]
#[path = "plugin_installations_tests.rs"]
mod tests;

pub struct InstallationService {
    store: Arc<dyn InstallationStore>,
    plugins: Arc<PluginService>,
    server_configurations: Arc<dyn PluginConfigurationStore>,
    browser_configurations: Arc<dyn BrowserConfigurationStore>,
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
        })
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
        if let Some(expected) = &expected_revision {
            validate_release_digest(expected)?;
        }
        let prepared = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            prepared = self.store.prepare(source) => prepared?,
        };
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
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
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let old_loaded = service.loaded_components(old.as_ref());
                if let Some(old) = &old {
                    if let Err(error) = service.unload(&plugins, old).await {
                        service.reload(&plugins, &old_loaded).await?;
                        return Err(error);
                    }
                }
                // 提交开始后即使调用方离开，也持有生命周期门禁直到恢复稳定状态。
                let installed = match prepared.commit(expected_revision).await {
                    Ok(value) => value,
                    Err(error) => {
                        service.reload(&plugins, &old_loaded).await?;
                        return Err(error);
                    }
                };
                let activation = async {
                    if service.requires_configuration(&installed).await? {
                        return service
                            .store
                            .configuration_required(&installed.id, &installed.revision)
                            .await;
                    }
                    if old.as_ref().is_none_or(|old| old.enabled) {
                        service.enable(&plugins, &installed).await
                    } else {
                        Ok(installed.clone())
                    }
                }
                .await;
                match activation {
                    Ok(value) => Ok(value),
                    Err(error) => {
                        service.unload(&plugins, &installed).await?;
                        if old.is_some() {
                            service
                                .store
                                .restore_previous(&installed.id, &installed.revision)
                                .await?;
                            service.reload(&plugins, &old_loaded).await?;
                        } else {
                            service
                                .store
                                .delete(&installed.id, &installed.revision)
                                .await?;
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
        plugin_id(&id)?;
        validate_release_digest(&expected_revision)?;
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                let release = service.current(&id, &expected_revision).await?;
                if enabled {
                    if service.requires_configuration(&release).await? {
                        service.unload(&plugins, &release).await?;
                        return service
                            .store
                            .configuration_required(&id, &expected_revision)
                            .await;
                    }
                    service.enable(&plugins, &release).await
                } else {
                    let previous = service.loaded_components(Some(&release));
                    if let Err(error) = service.unload(&plugins, &release).await {
                        service.reload(&plugins, &previous).await?;
                        return Err(error);
                    }
                    match service
                        .store
                        .set_enabled(&id, &expected_revision, false)
                        .await
                    {
                        Ok(value) => Ok(value),
                        Err(error) => {
                            service.reload(&plugins, &previous).await?;
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
        plugin_id(&id)?;
        validate_release_digest(&expected_revision)?;
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                let release = service.current(&id, &expected_revision).await?;
                if release.enabled {
                    return Err(Error::Conflict("启用中的发布不能删除，请先停用".into()));
                }
                service.unload(&plugins, &release).await?;
                service.store.delete(&id, &expected_revision).await
            })
            .await
    }

    /// 启动时恢复持久化启用状态；缺少账号输入时保持明确的待配置状态。
    pub async fn restore(self: &Arc<Self>) -> Result<()> {
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                for release in service.store.list().await? {
                    if !release.enabled {
                        continue;
                    }
                    if service.requires_configuration(&release).await? {
                        service
                            .store
                            .configuration_required(&release.id, &release.revision)
                            .await?;
                    } else {
                        service.enable(&plugins, &release).await?;
                    }
                }
                Ok(())
            })
            .await
    }
    pub async fn reconcile_startup(self: &Arc<Self>) -> Result<()> {
        self.restore().await
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
    async fn reload(&self, plugins: &PluginService, ids: &[String]) -> Result<()> {
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
            self.store
                .set_enabled(&release.id, &release.revision, true)
                .await
        }
        .await;
        if outcome.is_err() {
            for id in loaded.into_iter().rev() {
                plugins.unload_idle_serialized(&id).await?;
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
            let values = match component.kind {
                PackageKind::Server => match self
                    .server_configurations
                    .requirements_configured(&component.id, &[requirement.config_pointer.clone()])
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
            if !values
                .as_ref()
                .and_then(|values| values.pointer(&requirement.config_pointer))
                .is_some_and(configured)
            {
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
