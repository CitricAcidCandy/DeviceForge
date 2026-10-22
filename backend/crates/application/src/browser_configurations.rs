//! 浏览器配置用例只校验身份和记录，不依赖包目录或浏览器运行状态。
use apk_domain::{Result, browser_configurations::*, plugins::plugin_id};
use std::sync::Arc;

pub struct BrowserConfigurationService {
    store: Arc<dyn BrowserConfigurationStore>,
}

impl BrowserConfigurationService {
    pub fn new(store: Arc<dyn BrowserConfigurationStore>) -> Arc<Self> {
        Arc::new(Self { store })
    }

    pub async fn get(&self, id: &str) -> Result<BrowserConfigurationView> {
        plugin_id(id)?;
        Ok(BrowserConfigurationView {
            record: self.store.get(id).await?,
        })
    }

    pub async fn patch(
        &self,
        id: &str,
        expected: Option<String>,
        record: BrowserConfigurationRecord,
    ) -> Result<BrowserConfigurationView> {
        plugin_id(id)?;
        if let Some(revision) = &expected {
            validate_browser_revision(revision)?;
        }
        record.validate()?;
        Ok(BrowserConfigurationView {
            record: Some(self.store.patch(id, expected, record).await?),
        })
    }
}
