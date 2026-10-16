//! 配置保存与应用编排；文件、模式解析和进程环境由领域端口负责。
use crate::plugin_lifecycle::PluginService;
use apk_domain::{Error, Result, plugin_configurations::*, plugins::plugin_id};
use serde_json::Value;
use std::sync::Arc;

pub struct PluginConfigurationService {
    store: Arc<dyn PluginConfigurationStore>,
    plugins: Arc<PluginService>,
    changes: tokio::sync::Mutex<()>,
}
impl PluginConfigurationService {
    pub fn new(store: Arc<dyn PluginConfigurationStore>, plugins: Arc<PluginService>) -> Arc<Self> {
        Arc::new(Self {
            store,
            plugins,
            changes: tokio::sync::Mutex::new(()),
        })
    }
    pub async fn list(&self) -> Result<Vec<PluginConfiguration>> {
        self.store.list().await
    }
    pub async fn get(&self, id: &str) -> Result<PluginConfiguration> {
        plugin_id(id)?;
        self.store.get(id).await
    }
    pub async fn patch(
        &self,
        id: &str,
        expected: u64,
        patch: Value,
    ) -> Result<PluginConfiguration> {
        plugin_id(id)?;
        let _change = self
            .changes
            .try_lock()
            .map_err(|_| Error::Conflict("插件配置变更正在执行".into()))?;
        self.store.patch(id, expected, patch).await
    }
    pub async fn reset(&self, id: &str, expected: u64) -> Result<PluginConfiguration> {
        plugin_id(id)?;
        let _change = self
            .changes
            .try_lock()
            .map_err(|_| Error::Conflict("插件配置变更正在执行".into()))?;
        self.store.reset(id, expected).await
    }
    pub async fn apply(&self, id: &str, expected: u64) -> Result<PluginConfiguration> {
        plugin_id(id)?;
        let _change = self
            .changes
            .try_lock()
            .map_err(|_| Error::Conflict("插件配置变更正在执行".into()))?;
        self.plugins
            .apply_configuration(self.store.clone(), id.into(), expected)
            .await
    }
}
