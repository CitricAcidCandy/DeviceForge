//! 持久发布查询、启用状态与不可变浏览器资源读取。
use super::{FilePluginInstallations, content, paths, prepare, transaction};
use apk_domain::{
    Error, Result, plugin_installations::*, plugin_packages::PackageAsset, plugins::plugin_id,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) fn record_path(root: &Path, id: &str) -> PathBuf {
    root.join("installations/releases")
        .join(format!("{id}.json"))
}
pub(super) fn optional(
    store: &FilePluginInstallations,
    id: &str,
) -> Result<Option<InstalledRelease>> {
    read_optional(&store.root, id)
}
pub(super) fn read_optional(root: &Path, id: &str) -> Result<Option<InstalledRelease>> {
    plugin_id(id)?;
    let path = record_path(root, id);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let record: InstalledRelease = paths::read(&path, 512 * 1024)?;
            if record.id != id {
                return Err(Error::Invalid("安装记录身份不匹配".into()));
            }
            validate_release_digest(&record.revision)?;
            validate_record(&record)?;
            Ok(Some(record))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Error::Storage("安装记录不可访问".into())),
    }
}
pub(super) fn validate_record(record: &InstalledRelease) -> Result<()> {
    plugin_id(&record.id)?;
    validate_release_digest(&record.revision)?;
    if record.components.is_empty() || record.components.len() > 32 || record.tools.len() > 128 {
        return Err(Error::TooLarge);
    }
    for component in &record.components {
        plugin_id(&component.id)?;
        validate_release_digest(&component.revision)?;
        validate_release_path(&component.entry_path)?;
        if component.revision != record.revision {
            return Err(Error::Invalid("组件修订与发布记录不符".into()));
        }
    }
    for tool in &record.tools {
        plugin_id(&tool.id)?;
        validate_release_path(&tool.version)?;
        validate_release_path(&tool.platform)?;
        if tool.version.contains('/') || tool.platform.contains('/') {
            return Err(Error::Invalid("工具版本或平台标识无效".into()));
        }
        validate_release_digest(&tool.sha256)?;
    }
    Ok(())
}
pub(super) fn block(
    root: &Path,
    mut record: InstalledRelease,
    phase: &str,
    reason: &str,
) -> Result<InstalledRelease> {
    record.status = InstallationStatus::RecoveryBlocked;
    record.failure = Some(InstallationFailure {
        phase: phase.chars().take(128).collect(),
        reason: reason.chars().take(1024).collect(),
    });
    paths::write(&record_path(root, &record.id), &record)?;
    Ok(record)
}
pub(super) fn list(store: &FilePluginInstallations) -> Result<Vec<InstalledRelease>> {
    let mut records = Vec::new();
    for (count, entry) in fs::read_dir(store.root.join("installations/releases"))
        .map_err(|_| Error::Storage("安装目录读取失败".into()))?
        .enumerate()
    {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let entry = entry.map_err(|_| Error::Storage("安装记录读取失败".into()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_suffix(".json")
            .ok_or_else(|| Error::Invalid("安装记录文件名无效".into()))?;
        if let Some(record) = optional(store, id)? {
            records.push(record);
        }
    }
    records.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(records)
}
pub(super) fn require_revision(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
) -> Result<InstalledRelease> {
    validate_release_digest(expected)?;
    let record =
        optional(store, id)?.ok_or_else(|| Error::NotFound("统一安装发布不存在".into()))?;
    if record.revision != expected {
        return Err(Error::Conflict("已安装发布修订变化，请刷新后重试".into()));
    }
    Ok(record)
}
pub(super) fn component_root(
    root: &Path,
    kind: apk_domain::plugin_packages::PackageKind,
    id: &str,
) -> PathBuf {
    root.join(
        if kind == apk_domain::plugin_packages::PackageKind::Server {
            "plugins"
        } else {
            "browser-plugins"
        },
    )
    .join(id)
}

#[async_trait::async_trait]
impl InstallationStore for FilePluginInstallations {
    async fn plan(&self, source: InstallSource) -> Result<InstallationPlan> {
        prepare::plan(self, source).await
    }
    async fn prepare(&self, source: InstallSource) -> Result<Box<dyn PreparedInstallation>> {
        prepare::prepare(self, source).await
    }
    async fn prepare_with_progress(
        &self,
        source: InstallSource,
        progress: std::sync::Arc<dyn apk_domain::ProgressReporter>,
    ) -> Result<Box<dyn PreparedInstallation>> {
        prepare::prepare_reported(self, source, progress).await
    }
    async fn list(&self) -> Result<Vec<InstalledRelease>> {
        self.work(list).await
    }
    async fn get(&self, id: &str) -> Result<InstalledRelease> {
        plugin_id(id)?;
        let id = id.to_owned();
        self.work(move |store| {
            optional(store, &id)?.ok_or_else(|| Error::NotFound("统一安装发布不存在".into()))
        })
        .await
    }
    async fn set_enabled(
        &self,
        id: &str,
        expected_revision: &str,
        enabled: bool,
    ) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        self.work(move |store| {
            let mut record = require_revision(store, &id, &expected)?;
            if record.requires_recovery() {
                return Err(Error::Conflict("发布恢复受阻，需先修复或完成恢复".into()));
            }
            record.enabled = enabled;
            if !record.has_retryable_component_warning() {
                record.failure = None;
            }
            record.status = if enabled {
                InstallationStatus::Enabled
            } else {
                InstallationStatus::Installed
            };
            paths::write(&record_path(&store.root, &id), &record)?;
            Ok(record)
        })
        .await
    }
    async fn delete(&self, id: &str, expected_revision: &str) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        self.work(move |store| {
            let record = require_revision(store, &id, &expected)?;
            // 安装回滚需要删除尚未激活、但保留启用意图的 Installed 记录。
            // 对外删除仍由应用生命周期门禁要求先停用。
            if record.status == InstallationStatus::Enabled || record.requires_recovery() {
                return Err(Error::Conflict("启用中的发布不能删除".into()));
            }
            transaction::delete(store, &record)?;
            Ok(record)
        })
        .await
    }
    async fn configuration_required(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        self.work(move |store| {
            let mut record = require_revision(store, &id, &expected)?;
            if record.requires_recovery() {
                return Err(Error::Conflict("恢复受阻的发布不能改为待配置".into()));
            }
            record.enabled = false;
            record.status = InstallationStatus::ConfigurationRequired;
            paths::write(&record_path(&store.root, &id), &record)?;
            Ok(record)
        })
        .await
    }
    async fn dependencies_required(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        self.work(move |store| {
            let mut record = require_revision(store, &id, &expected)?;
            if record.requires_recovery() {
                return Err(Error::Conflict("恢复受阻的发布不能改为待安装依赖".into()));
            }
            record.status = InstallationStatus::DependenciesRequired;
            paths::write(&record_path(&store.root, &id), &record)?;
            Ok(record)
        })
        .await
    }
    async fn recovery_blocked(
        &self,
        id: &str,
        expected_revision: &str,
        phase: &str,
        reason: &str,
    ) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        let phase = phase.to_owned();
        let reason = reason.to_owned();
        self.work(move |store| {
            let record = require_revision(store, &id, &expected)?;
            block(&store.root, record, &phase, &reason)
        })
        .await
    }
    async fn cleanup_resources(
        &self,
        dry_run: bool,
        running_components: Vec<String>,
    ) -> Result<ResourceCleanupReport> {
        self.work(move |store| super::cleanup::resources(store, dry_run, &running_components))
            .await
    }
    async fn restore_previous(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<InstalledRelease> {
        let id = id.to_owned();
        let expected = expected_revision.to_owned();
        self.work(move |store| transaction::restore_previous(store, &id, &expected))
            .await
    }
    async fn record_successful_activation(&self, id: &str, expected_revision: &str) -> Result<()> {
        let (id, expected) = (id.to_owned(), expected_revision.to_owned());
        self.work(move |store| transaction::successful::mark(store, &id, &expected))
            .await
    }
    async fn previous_successful(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<SuccessfulRelease> {
        let (id, expected) = (id.to_owned(), expected_revision.to_owned());
        self.work(move |store| transaction::successful::previous(store, &id, &expected))
            .await
    }
    async fn restore_previous_successful(
        &self,
        id: &str,
        expected_revision: &str,
        target_revision: &str,
        context: apk_domain::ExecutionContext,
    ) -> Result<InstalledRelease> {
        let (id, expected, target) = (
            id.to_owned(),
            expected_revision.to_owned(),
            target_revision.to_owned(),
        );
        self.work(move |store| {
            transaction::successful::restore_successful(store, &id, &expected, &target, context)
        })
        .await
    }
    async fn activation_pending(
        &self,
        id: &str,
        expected_revision: &str,
        enabled: bool,
        status: InstallationStatus,
    ) -> Result<InstalledRelease> {
        if !matches!(
            status,
            InstallationStatus::ConfigurationRequired | InstallationStatus::DependenciesRequired
        ) {
            return Err(Error::Invalid("待激活状态只能表示缺少配置或依赖".into()));
        }
        let (id, expected) = (id.to_owned(), expected_revision.to_owned());
        self.work(move |store| {
            let mut current = require_revision(store, &id, &expected)?;
            if current.requires_recovery() {
                return Err(Error::Conflict("不能覆盖未决文件事务".into()));
            }
            current.enabled = enabled;
            current.status = status;
            paths::write(&record_path(&store.root, &id), &current)?;
            Ok(current)
        })
        .await
    }
    async fn asset(&self, component_id: &str, revision: &str, path: &str) -> Result<PackageAsset> {
        use futures_util::TryStreamExt;
        plugin_id(component_id)?;
        validate_release_digest(revision)?;
        validate_release_path(path)?;
        if [
            "resources.json",
            "installation.json",
            "inventory.json",
            "market.json",
            "manifest.json",
        ]
        .contains(&path)
        {
            return Err(Error::NotFound("宿主内部安装文件不作为公开资源提供".into()));
        }
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("安装资源读取并发已满".into()))?;
        let id = component_id.to_owned();
        let revision = revision.to_owned();
        let relative = path.to_owned();
        let content_type = match path.rsplit('.').next().unwrap_or("") {
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" | "map" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "wasm" => "application/wasm",
            _ => "application/octet-stream",
        }
        .to_owned();
        let (file, size) = self
            .work(move |store| {
                let root = store
                    .root
                    .join("browser-plugins")
                    .join(&id)
                    .join("revisions")
                    .join(&revision);
                paths::directory(&root)?;
                let marker: serde_json::Value =
                    paths::read(&root.join("installation.json"), 65_536)?;
                if marker["component_id"] != id || marker["revision"] != revision {
                    return Err(Error::Invalid("浏览器资源版本身份不符".into()));
                }
                let inventory: content::Inventory =
                    paths::read(&root.join("inventory.json"), 32 * 1024 * 1024)?;
                let expected = inventory
                    .get(&relative)
                    .ok_or_else(|| Error::NotFound("浏览器发布资源不存在".into()))?;
                let path = paths::existing(&root, &relative)?;
                if content::hash(&path, RELEASE_RESOURCE_LIMIT)? != *expected {
                    return Err(Error::Invalid("浏览器资源校验失败".into()));
                }
                let file = fs::File::open(path)
                    .map_err(|_| Error::Storage("浏览器资源打开失败".into()))?;
                Ok((file, expected.size))
            })
            .await?;
        let stream =
            tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file)).map_err(move |_| {
                let _ = &permit;
                Error::Storage("浏览器资源传输失败".into())
            });
        Ok(PackageAsset {
            content_type,
            size,
            stream: Box::pin(stream),
        })
    }
}
