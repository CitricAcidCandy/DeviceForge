use super::*;
use apk_domain::{
    browser_configurations::BrowserConfigurationRecord, plugin_configurations::*, plugins::*,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Mutex;

fn release(id: &str, revision: char) -> InstalledRelease {
    InstalledRelease {
        id: id.into(),
        version: revision.to_string(),
        name: "测试发布".into(),
        description: "安装生命周期测试".into(),
        revision: revision.to_string().repeat(64),
        enabled: false,
        status: InstallationStatus::Installed,
        installed_at: 0,
        components: vec![InstalledComponent {
            id: "sample_browser".into(),
            kind: PackageKind::Browser,
            version: revision.to_string(),
            revision: revision.to_string().repeat(64),
            entry_path: "index.js".into(),
            entry_url: None,
        }],
        tools: vec![],
        requirements: vec![],
    }
}

struct Store {
    current: Arc<Mutex<Option<InstalledRelease>>>,
    previous: Arc<Mutex<Option<InstalledRelease>>>,
    next: InstalledRelease,
}
struct Prepared {
    current: Arc<Mutex<Option<InstalledRelease>>>,
    previous: Arc<Mutex<Option<InstalledRelease>>>,
    info: InstalledRelease,
}
#[async_trait]
impl PreparedInstallation for Prepared {
    fn info(&self) -> &InstalledRelease {
        &self.info
    }
    fn operations(&self) -> &[apk_domain::Operation] {
        &[]
    }
    async fn commit(self: Box<Self>, expected: Option<String>) -> Result<InstalledRelease> {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().map(|value| value.revision.as_str()) != expected.as_deref() {
            return Err(Error::Conflict("修订不符".into()));
        }
        *self.previous.lock().unwrap() = current.clone();
        *current = Some(self.info.clone());
        Ok(self.info)
    }
}
#[async_trait]
impl InstallationStore for Store {
    async fn plan(&self, _: InstallSource) -> Result<InstallationPlan> {
        Err(Error::Invalid("本用例不调用计划".into()))
    }
    async fn prepare(&self, _: InstallSource) -> Result<Box<dyn PreparedInstallation>> {
        Ok(Box::new(Prepared {
            current: self.current.clone(),
            previous: self.previous.clone(),
            info: self.next.clone(),
        }))
    }
    async fn list(&self) -> Result<Vec<InstalledRelease>> {
        Ok(self.current.lock().unwrap().iter().cloned().collect())
    }
    async fn get(&self, id: &str) -> Result<InstalledRelease> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|value| value.id == id)
            .cloned()
            .ok_or_else(|| Error::NotFound("没有发布".into()))
    }
    async fn set_enabled(
        &self,
        id: &str,
        expected: &str,
        enabled: bool,
    ) -> Result<InstalledRelease> {
        let mut value = self.get(id).await?;
        if value.revision != expected {
            return Err(Error::Conflict("修订不符".into()));
        }
        value.enabled = enabled;
        value.status = if enabled {
            InstallationStatus::Enabled
        } else {
            InstallationStatus::Installed
        };
        *self.current.lock().unwrap() = Some(value.clone());
        Ok(value)
    }
    async fn configuration_required(&self, id: &str, expected: &str) -> Result<InstalledRelease> {
        let mut value = self.set_enabled(id, expected, false).await?;
        value.status = InstallationStatus::ConfigurationRequired;
        *self.current.lock().unwrap() = Some(value.clone());
        Ok(value)
    }
    async fn restore_previous(&self, _: &str, _: &str) -> Result<InstalledRelease> {
        let previous = self.previous.lock().unwrap().clone().unwrap();
        *self.current.lock().unwrap() = Some(previous.clone());
        Ok(previous)
    }
    async fn delete(&self, id: &str, _: &str) -> Result<InstalledRelease> {
        let value = self.get(id).await?;
        *self.current.lock().unwrap() = None;
        Ok(value)
    }
    async fn asset(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<apk_domain::plugin_packages::PackageAsset> {
        Err(Error::NotFound("无资源".into()))
    }
}

struct Configurations {
    values: Mutex<Option<BrowserConfigurationRecord>>,
}
#[async_trait]
impl BrowserConfigurationStore for Configurations {
    async fn get(&self, _: &str) -> Result<Option<BrowserConfigurationRecord>> {
        Ok(self.values.lock().unwrap().clone())
    }
    async fn patch(
        &self,
        _: &str,
        _: Option<String>,
        record: BrowserConfigurationRecord,
    ) -> Result<BrowserConfigurationRecord> {
        *self.values.lock().unwrap() = Some(record.clone());
        Ok(record)
    }
}
#[async_trait]
impl PluginConfigurationStore for Configurations {
    async fn list(&self) -> Result<Vec<PluginConfiguration>> {
        Ok(vec![])
    }
    async fn get(&self, _: &str) -> Result<PluginConfiguration> {
        Err(Error::NotFound("无服务器配置".into()))
    }
    async fn patch(&self, _: &str, _: u64, _: Value) -> Result<PluginConfiguration> {
        Err(Error::Invalid("不支持".into()))
    }
    async fn reset(&self, _: &str, _: u64) -> Result<PluginConfiguration> {
        Err(Error::Invalid("不支持".into()))
    }
    async fn mark_applied(&self, _: &str, _: u64) -> Result<PluginConfiguration> {
        Err(Error::Invalid("不支持".into()))
    }
    async fn invocation_path(&self, _: &str) -> Result<Option<std::path::PathBuf>> {
        Ok(None)
    }
}
struct FailingCatalog;
#[async_trait]
impl PluginCatalog for FailingCatalog {
    async fn load(&self, _: &str) -> Result<PluginContribution> {
        Err(Error::Invalid("模拟新组件贡献无法加载".into()))
    }
}

fn setup(
    next: InstalledRelease,
    current: Option<InstalledRelease>,
) -> (Arc<InstallationService>, Arc<Store>, Arc<Configurations>) {
    let store = Arc::new(Store {
        current: Arc::new(Mutex::new(current)),
        previous: Arc::new(Mutex::new(None)),
        next,
    });
    let app = crate::Application::new(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let plugins = PluginService::new(app, Arc::new(FailingCatalog), Default::default());
    plugins.bind_installations(store.clone()).unwrap();
    let configurations = Arc::new(Configurations {
        values: Mutex::new(None),
    });
    (
        InstallationService::new(
            store.clone(),
            plugins,
            configurations.clone(),
            configurations.clone(),
        ),
        store,
        configurations,
    )
}
fn source() -> InstallSource {
    InstallSource::Offline {
        artifact_id: "test-upload".into(),
    }
}

#[tokio::test]
async fn new_release_enables_by_default_and_old_api_cannot_toggle_component() {
    let (service, _, _) = setup(release("feature", 'a'), None);
    let installed = service.install(source(), None).await.unwrap();
    assert!(installed.enabled);
    assert_eq!(installed.status, InstallationStatus::Enabled);
    assert!(matches!(
        service.plugins.load("sample_browser".into()).await,
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        service.plugins.unload("sample_browser".into()).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn missing_required_configuration_stays_disabled_then_user_can_enable() {
    let mut next = release("feature", 'a');
    next.requirements.push(ReleaseRequirement {
        component_id: "sample_browser".into(),
        config_pointer: "/token".into(),
        title: "令牌".into(),
        description: "请输入账号令牌".into(),
        sensitive: true,
        required: true,
    });
    let (service, _, configurations) = setup(next, None);
    let installed = service.install(source(), None).await.unwrap();
    assert!(!installed.enabled);
    assert_eq!(installed.status, InstallationStatus::ConfigurationRequired);
    *configurations.values.lock().unwrap() = Some(BrowserConfigurationRecord {
        version: 1,
        values: json!({"token":"present"}),
        revision: "defaults".into(),
        applied: "defaults".into(),
        sensitive_paths: vec!["/token".into()],
    });
    let enabled = service
        .set_enabled(installed.id, installed.revision, true)
        .await
        .unwrap();
    assert!(enabled.enabled);
}

#[tokio::test]
async fn update_preserves_disabled_and_foreign_revision_cannot_create_another_id() {
    let old = release("feature", 'a');
    let (service, _, _) = setup(release("feature", 'b'), Some(old.clone()));
    assert!(
        !service
            .install(source(), Some(old.revision.clone()))
            .await
            .unwrap()
            .enabled
    );
    let (service, store, _) = setup(release("other", 'b'), Some(old.clone()));
    assert!(matches!(
        service.install(source(), Some(old.revision.clone())).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(store.get("feature").await.unwrap().revision, old.revision);
}

#[tokio::test]
async fn failed_new_component_restores_previous_release_and_pre_cancel_does_not_commit() {
    let mut old = release("feature", 'a');
    old.enabled = true;
    old.status = InstallationStatus::Enabled;
    let mut next = release("feature", 'b');
    next.components[0].kind = PackageKind::Server;
    next.components[0].id = "server".into();
    let (service, store, _) = setup(next, Some(old.clone()));
    assert!(
        service
            .install(source(), Some(old.revision.clone()))
            .await
            .is_err()
    );
    assert_eq!(store.get("feature").await.unwrap().revision, old.revision);
    assert!(store.get("feature").await.unwrap().enabled);
    let (service, store, _) = setup(release("feature", 'a'), None);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        service.install_cancelled(source(), None, cancel).await,
        Err(Error::Cancelled)
    ));
    assert!(store.list().await.unwrap().is_empty());
}
