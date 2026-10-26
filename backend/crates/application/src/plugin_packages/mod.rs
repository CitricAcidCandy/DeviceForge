//! 包部署编排与运行状态门禁，不承担归档或路径副作用。
use crate::{plugin_lifecycle::PluginService, registration};
use apk_domain::{
    Error, Result, artifacts::ArtifactStream, plugin_packages::*, plugins::plugin_id,
};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

pub struct PackageService {
    store: Arc<dyn PackageStore>,
    plugins: Arc<PluginService>,
    validators: Arc<tokio::sync::Semaphore>,
    installations: OnceLock<Arc<dyn apk_domain::plugin_installations::InstallationStore>>,
    dependencies: OnceLock<Arc<crate::plugin_dependencies::DependencyService>>,
}
impl PackageService {
    pub fn new(store: Arc<dyn PackageStore>, plugins: Arc<PluginService>) -> Arc<Self> {
        Arc::new(Self {
            store,
            plugins,
            validators: Arc::new(tokio::sync::Semaphore::new(2)),
            installations: OnceLock::new(),
            dependencies: OnceLock::new(),
        })
    }
    pub fn bind_dependencies(
        &self,
        service: Arc<crate::plugin_dependencies::DependencyService>,
    ) -> Result<()> {
        self.dependencies
            .set(service)
            .map_err(|_| Error::Conflict("包依赖服务已绑定".into()))
    }
    async fn detect_dependencies(
        &self,
        info: &PackageInfo,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        let Some(service) = self.dependencies.get() else {
            return Ok(());
        };
        use apk_domain::plugin_dependencies::*;
        let target = DependencyTarget {
            kind: if info.kind == PackageKind::Browser {
                DependencyTargetKind::Browser
            } else {
                DependencyTargetKind::Server
            },
            id: info.id.clone(),
        };
        service
            .ensure(
                target,
                cancel,
                apk_domain::ExecutionContext {
                    deadline: Some(std::time::Instant::now() + Duration::from_secs(3_600)),
                },
                Arc::new(apk_domain::NoProgress),
            )
            .await?;
        Ok(())
    }
    pub fn bind_installations(
        &self,
        store: Arc<dyn apk_domain::plugin_installations::InstallationStore>,
    ) -> Result<()> {
        self.installations
            .set(store)
            .map_err(|_| Error::Conflict("完整发布存储已绑定".into()))
    }
    async fn require_unmanaged(&self, kind: PackageKind, id: &str) -> Result<()> {
        if let Some(store) = self.installations.get() {
            for release in store.list().await? {
                if release
                    .components
                    .iter()
                    .any(|component| component.kind == kind && component.id == id)
                {
                    return Err(Error::Conflict(
                        "该组件由完整发布管理，请使用完整插件更新或卸载入口".into(),
                    ));
                }
            }
        }
        Ok(())
    }
    pub async fn list(&self, kind: PackageKind) -> Result<Vec<PackageInfo>> {
        self.store.list(kind).await
    }
    pub async fn install(
        self: &Arc<Self>,
        kind: PackageKind,
        format: PackageFormat,
        stream: ArtifactStream,
    ) -> Result<PackageInfo> {
        self.install_expected(kind, format, stream, None, None)
            .await
    }
    pub async fn install_expected(
        self: &Arc<Self>,
        kind: PackageKind,
        format: PackageFormat,
        stream: ArtifactStream,
        expected_id: Option<String>,
        expected_version: Option<String>,
    ) -> Result<PackageInfo> {
        let prepared = tokio::time::timeout(
            Duration::from_secs(120),
            self.prepare(kind, format, stream, expected_id, expected_version),
        )
        .await
        .map_err(|_| Error::Timeout)??;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let service = self.clone();
        let before_commit = cancel.clone();
        let info = self
            .plugins
            .serialized(move |_| async move {
                if before_commit.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                service.require_unmanaged(kind, &prepared.info().id).await?;
                prepared.commit().await
            })
            .await?;
        // 网络准备不持有全局插件管理锁；请求离开后仍保留已提交的部署文件。
        self.detect_dependencies(&info, cancel).await?;
        Ok(info)
    }
    async fn prepare(
        &self,
        kind: PackageKind,
        format: PackageFormat,
        stream: ArtifactStream,
        expected_id: Option<String>,
        expected_version: Option<String>,
    ) -> Result<Box<dyn PreparedPackage>> {
        if let Some(id) = &expected_id {
            plugin_id(id)?;
        }
        if expected_version.as_ref().is_some_and(|version| {
            version.is_empty() || version.len() > 100 || version.chars().any(char::is_control)
        }) {
            return Err(Error::Invalid("期望包版本无效".into()));
        }
        let prepared = self.store.prepare(kind, format, stream).await?;
        if prepared.info().kind != kind
            || expected_id
                .as_ref()
                .is_some_and(|id| prepared.info().id != *id)
            || expected_version
                .as_ref()
                .is_some_and(|version| prepared.info().version != *version)
        {
            return Err(Error::Invalid(
                "包清单身份或版本与市场条目不一致，部署未更改".into(),
            ));
        }
        let permit = self
            .validators
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("包注册验证工作池已满".into()))?;
        // 模式编译在阻塞池执行；数量与暂存并发由部署端口限制。
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            registration::validate_operations(prepared.operations())?;
            Ok::<_, Error>(prepared)
        })
        .await
        .map_err(|_| Error::Dependency("包操作验证异常".into()))?
    }
    pub async fn update(
        self: &Arc<Self>,
        kind: PackageKind,
        id: String,
        format: PackageFormat,
        stream: ArtifactStream,
        expected_version: Option<String>,
    ) -> Result<PackageInfo> {
        let prepared = tokio::time::timeout(
            Duration::from_secs(120),
            self.prepare(kind, format, stream, Some(id.clone()), expected_version),
        )
        .await
        .map_err(|_| Error::Timeout)??;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let before_commit = cancel.clone();
        let service = self.clone();
        let info = self
            .plugins
            .serialized(move |plugins| async move {
                if before_commit.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                service.require_unmanaged(kind, &id).await?;
                require_unloaded(&plugins, kind, &id)?;
                prepared.replace().await
            })
            .await?;
        self.detect_dependencies(&info, cancel).await?;
        Ok(info)
    }
    pub async fn delete(self: &Arc<Self>, kind: PackageKind, id: String) -> Result<PackageInfo> {
        plugin_id(&id)?;
        let store = self.store.clone();
        let service = self.clone();
        self.plugins
            .serialized(move |plugins| async move {
                service.require_unmanaged(kind, &id).await?;
                require_unloaded(&plugins, kind, &id)?;
                let record = store.delete(kind, &id).await?;
                if let Some(dependencies) = service.dependencies.get() {
                    dependencies
                        .forget(apk_domain::plugin_dependencies::DependencyTarget {
                            kind: if kind == PackageKind::Browser {
                                apk_domain::plugin_dependencies::DependencyTargetKind::Browser
                            } else {
                                apk_domain::plugin_dependencies::DependencyTargetKind::Server
                            },
                            id,
                        })
                        .await?;
                }
                Ok(record)
            })
            .await
    }
    pub async fn asset(&self, id: &str, path: &str) -> Result<PackageAsset> {
        self.store.asset(id, path).await
    }
}

fn require_unloaded(plugins: &PluginService, kind: PackageKind, id: &str) -> Result<()> {
    if kind == PackageKind::Server
        && let Some(owner) = plugins.list().iter().find(|owner| owner.id == id)
    {
        return Err(Error::Conflict(format!(
            "服务器插件 {} 仍已加载或正在排空，请先完成卸载",
            owner.id
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
