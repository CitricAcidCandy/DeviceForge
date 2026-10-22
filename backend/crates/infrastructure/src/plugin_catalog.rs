//! 固定部署目录的受限读取；注册和生命周期属于用例层。
use crate::plugins::ProcessPlugin;
use apk_domain::{Error, Result, artifacts::ArtifactStore, plugins::*};
use async_trait::async_trait;
use deviceforge_observability::LogContext;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Semaphore;
pub(crate) mod metadata;

pub struct FilePluginCatalog {
    root: Arc<PathBuf>,
    artifacts: Arc<dyn ArtifactStore>,
    workers: Arc<Semaphore>,
    configurations: Option<Arc<dyn apk_domain::plugin_configurations::PluginConfigurationStore>>,
}
impl FilePluginCatalog {
    pub async fn open(root: &Path, artifacts: Arc<dyn ArtifactStore>) -> Result<Self> {
        let root = tokio::fs::canonicalize(root)
            .await
            .map_err(|_| Error::Storage("插件部署目录不可访问".into()))?;
        if !tokio::fs::metadata(&root)
            .await
            .map_err(|_| Error::Storage("插件部署目录不可访问".into()))?
            .is_dir()
        {
            return Err(Error::Invalid("插件部署根路径必须是目录".into()));
        }
        Ok(Self {
            root: Arc::new(root),
            artifacts,
            workers: Arc::new(Semaphore::new(2)),
            configurations: None,
        })
    }
    pub fn with_configurations(
        mut self,
        configurations: Arc<dyn apk_domain::plugin_configurations::PluginConfigurationStore>,
    ) -> Self {
        self.configurations = Some(configurations);
        self
    }
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Path, Arc<dyn ArtifactStore>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::Storage("插件部署工作池已关闭".into()))?;
        let root = self.root.clone();
        let artifacts = self.artifacts.clone();
        let context = LogContext::current().unwrap_or_default();
        let span = tracing::Span::current();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            context.sync_scope(|| span.in_scope(|| work(&root, artifacts)))
        })
        .await
        .map_err(|_| Error::Dependency("插件部署读取工作异常".into()))?
    }
    pub async fn initial(&self) -> Result<Vec<Arc<ProcessPlugin>>> {
        let configurations = self.configurations.clone();
        self.blocking(move |root, artifacts| {
            let mut plugins = Vec::new();
            for (count, entry) in std::fs::read_dir(root)
                .map_err(|_| Error::Storage("插件目录读取失败".into()))?
                .enumerate()
            {
                if count >= 1024 {
                    return Err(Error::TooLarge);
                }
                let entry = entry.map_err(|_| Error::Storage("插件目录条目读取失败".into()))?;
                let name = entry.file_name();
                let id = name
                    .to_str()
                    .ok_or_else(|| Error::Invalid("插件目录名称必须为 UTF-8".into()))?;
                if id.starts_with('.') {
                    continue;
                }
                let kind = entry
                    .file_type()
                    .map_err(|_| Error::Storage("插件目录条目不可访问".into()))?;
                if kind.is_symlink() {
                    return Err(Error::Invalid("插件目录不得为链接".into()));
                }
                if !kind.is_dir() {
                    continue;
                }
                if plugins.len() >= 256 {
                    return Err(Error::TooLarge);
                }
                plugins.push(read_plugin(
                    root,
                    id,
                    artifacts.clone(),
                    configurations.clone(),
                )?);
            }
            plugins.sort_by(|left, right| left.manifest().id.cmp(&right.manifest().id));
            Ok(plugins)
        })
        .await
    }
}
fn read_plugin(
    root: &Path,
    id: &str,
    artifacts: Arc<dyn ArtifactStore>,
    configurations: Option<Arc<dyn apk_domain::plugin_configurations::PluginConfigurationStore>>,
) -> Result<Arc<ProcessPlugin>> {
    plugin_id(id)?;
    let directory = root.join(id);
    let metadata = std::fs::symlink_metadata(&directory)
        .map_err(|_| Error::NotFound("插件尚未部署".into()))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || std::fs::canonicalize(&directory)
            .map_err(|_| Error::Storage("插件目录不可访问".into()))?
            != directory
    {
        return Err(Error::Invalid("插件目录必须是部署根下的普通目录".into()));
    }
    let path = directory.join("manifest.json");
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| Error::NotFound("插件清单不存在".into()))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || std::fs::canonicalize(&path).map_err(|_| Error::Storage("插件清单不可访问".into()))?
            != path
    {
        return Err(Error::Invalid("插件清单必须是部署目录内的普通文件".into()));
    }
    if metadata.len() > 65536 {
        return Err(Error::TooLarge);
    }
    let file = std::fs::File::open(path).map_err(|_| Error::Storage("插件清单读取失败".into()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("插件清单读取失败".into()))?;
    if bytes.len() > 65536 {
        return Err(Error::TooLarge);
    }
    let manifest: apk_plugin_sdk::Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("插件清单不符合公开协议".into()))?;
    if manifest.id != id {
        return Err(Error::Invalid("插件 ID 必须与部署目录一致".into()));
    }
    let display = metadata::read(&directory, &manifest.id, &manifest.version);
    let mut plugin = ProcessPlugin::with_artifacts(manifest, artifacts)?.with_metadata(display);
    if let Some(configurations) = configurations {
        plugin = plugin.with_configurations(configurations);
    }
    Ok(Arc::new(plugin))
}
#[async_trait]
impl PluginCatalog for FilePluginCatalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        plugin_id(id)?;
        let id = id.to_owned();
        let configurations = self.configurations.clone();
        let plugin = self
            .blocking(move |root, artifacts| read_plugin(root, &id, artifacts, configurations))
            .await?;
        Ok(PluginContribution {
            id: plugin.manifest().id.clone(),
            version: plugin.manifest().version.clone(),
            executor: plugin,
        })
    }
}
