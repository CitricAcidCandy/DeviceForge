use super::*;
use apk_domain::{
    browser_configurations::BrowserConfigurationRecord, plugin_configurations::*, plugins::*,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Mutex;
#[path = "plugin_installations_tests/actions.rs"]
mod actions;

fn release(id: &str, revision: char) -> InstalledRelease {
    InstalledRelease {
        id: id.into(),
        version: revision.to_string(),
        name: "测试发布".into(),
        description: "安装生命周期测试".into(),
        revision: revision.to_string().repeat(64),
        enabled: false,
        status: InstallationStatus::Installed,
        failure: None,
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
    successful: Mutex<Vec<SuccessfulRelease>>,
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
        let mut info = self.info;
        info.enabled = current.as_ref().is_none_or(|record| record.enabled);
        *current = Some(info.clone());
        Ok(info)
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
        if value.requires_recovery() {
            return Err(Error::Conflict("恢复受阻".into()));
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
    async fn record_successful_activation(&self, id: &str, expected: &str) -> Result<()> {
        let current = self.get(id).await?;
        if current.revision != expected
            || !current.enabled
            || current.status != InstallationStatus::Enabled
        {
            return Err(Error::Conflict("成功版本身份或激活状态不符".into()));
        }
        let mut history = self.successful.lock().unwrap();
        history.retain(|entry| entry.release.revision != expected);
        history.insert(
            0,
            SuccessfulRelease {
                release: current,
                activated_at: apk_domain::now(),
                scope: SuccessfulReleaseScope::HostActivation,
            },
        );
        history.truncate(2);
        Ok(())
    }
    async fn previous_successful(&self, id: &str, expected: &str) -> Result<SuccessfulRelease> {
        if self.get(id).await?.revision != expected {
            return Err(Error::Conflict("修订不符".into()));
        }
        self.successful
            .lock()
            .unwrap()
            .iter()
            .find(|entry| entry.release.revision != expected)
            .cloned()
            .ok_or_else(|| Error::Conflict("没有成功版本证据".into()))
    }
    async fn restore_previous_successful(
        &self,
        id: &str,
        expected: &str,
        target: &str,
        context: apk_domain::ExecutionContext,
    ) -> Result<InstalledRelease> {
        if context
            .deadline
            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            return Err(Error::Timeout);
        }
        let current = self.get(id).await?;
        let mut previous = self.previous_successful(id, expected).await?.release;
        if previous.revision != target {
            return Err(Error::Conflict("成功版本已变化".into()));
        }
        previous.enabled = current.enabled;
        previous.status = InstallationStatus::Installed;
        *self.previous.lock().unwrap() = Some(current);
        *self.current.lock().unwrap() = Some(previous.clone());
        Ok(previous)
    }
    async fn activation_pending(
        &self,
        id: &str,
        expected: &str,
        enabled: bool,
        status: InstallationStatus,
    ) -> Result<InstalledRelease> {
        let mut current = self.get(id).await?;
        if current.revision != expected {
            return Err(Error::Conflict("修订不符".into()));
        }
        current.enabled = enabled;
        current.status = status;
        *self.current.lock().unwrap() = Some(current.clone());
        Ok(current)
    }
    async fn recovery_blocked(
        &self,
        id: &str,
        expected: &str,
        phase: &str,
        reason: &str,
    ) -> Result<InstalledRelease> {
        let mut value = self.get(id).await?;
        if value.revision != expected {
            return Err(Error::Conflict("修订不符".into()));
        }
        value.status = InstallationStatus::RecoveryBlocked;
        value.failure = Some(InstallationFailure {
            phase: phase.into(),
            reason: reason.into(),
        });
        *self.current.lock().unwrap() = Some(value.clone());
        Ok(value)
    }
    async fn cleanup_resources(
        &self,
        dry_run: bool,
        _: Vec<String>,
    ) -> Result<ResourceCleanupReport> {
        Ok(ResourceCleanupReport {
            dry_run,
            items: vec![],
            total_bytes: 0,
        })
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
        successful: Mutex::new(Vec::new()),
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
        any_of: vec![],
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
async fn either_requirement_source_enables_and_empty_sources_block_generic_browser_release() {
    for values in [
        json!({"local_manifest":"catalog.json","manifest_url":null}),
        json!({"local_manifest":null,"manifest_url":"https://example.invalid/catalog"}),
        json!({"local_manifest":null,"manifest_url":null}),
        json!({"local_manifest":" ","manifest_url":""}),
    ] {
        let mut next = release("third-party-source", 'a');
        next.requirements.push(ReleaseRequirement {
            component_id: "sample_browser".into(),
            config_pointer: "/local_manifest".into(),
            any_of: vec!["/manifest_url".into()],
            title: "清单来源".into(),
            description: "选择本地或远端清单".into(),
            sensitive: true,
            required: true,
        });
        let (service, _, configurations) = setup(next, None);
        *configurations.values.lock().unwrap() = Some(BrowserConfigurationRecord {
            version: 1,
            values: values.clone(),
            revision: "defaults".into(),
            applied: "defaults".into(),
            sensitive_paths: vec!["/local_manifest".into(), "/manifest_url".into()],
        });
        let installed = service.install(source(), None).await.unwrap();
        let expected = ["/local_manifest", "/manifest_url"]
            .iter()
            .any(|pointer| values.pointer(pointer).is_some_and(configured));
        assert_eq!(installed.enabled, expected);
        assert_eq!(
            installed.status,
            if expected {
                InstallationStatus::Enabled
            } else {
                InstallationStatus::ConfigurationRequired
            }
        );
        if !expected {
            let blocked = service
                .set_enabled(installed.id, installed.revision, true)
                .await
                .unwrap();
            assert!(!blocked.enabled);
            assert_eq!(blocked.status, InstallationStatus::ConfigurationRequired);
        }
    }
}

#[tokio::test]
async fn server_requirement_alternatives_read_original_sensitive_values_from_store() {
    use apk_infrastructure::plugin_configurations::FilePluginConfigurations;
    use std::fs;
    let directory = tempfile::tempdir().unwrap();
    let deployment = directory.path().join("plugins/sample_server");
    fs::create_dir_all(&deployment).unwrap();
    let manifest = json!({
        "id":"sample_server","version":"1","protocol_version":1,
        "executable":deployment.join("plugin.exe"),"args":[],"operations":[],
        "configuration":{
            "version":1,"apply_policy":"next_invocation",
            "schema":{"type":"object","additionalProperties":false,"properties":{
                "local_manifest":{"type":["string","null"],"writeOnly":true},
                "manifest_url":{"type":["string","null"],"writeOnly":true},
                "token":{"type":["string","null"],"writeOnly":true}
            }},
            "defaults":{"local_manifest":null,"manifest_url":null,"token":null}
        }
    });
    fs::write(
        deployment.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let configurations = FilePluginConfigurations::open(
        &directory.path().join("managed"),
        &directory.path().join("plugins"),
    )
    .await
    .unwrap();
    let mut next = release("third-party-source", 'a');
    next.components[0].kind = PackageKind::Server;
    next.components[0].id = "sample_server".into();
    next.requirements.push(ReleaseRequirement {
        component_id: "sample_server".into(),
        config_pointer: "/local_manifest".into(),
        any_of: vec!["/manifest_url".into()],
        title: "清单来源".into(),
        description: "选择本地或远端清单".into(),
        sensitive: true,
        required: true,
    });
    let (mut service, _, _) = setup(next.clone(), None);
    Arc::get_mut(&mut service).unwrap().server_configurations = configurations.clone();
    assert!(service.requires_configuration(&next).await.unwrap());
    for (revision, patch, required) in [
        (0, json!({"local_manifest":" ","manifest_url":""}), true),
        (
            1,
            json!({"manifest_url":"https://example.invalid/catalog"}),
            false,
        ),
        (
            2,
            json!({"manifest_url":null,"local_manifest":"catalog.json"}),
            false,
        ),
    ] {
        let masked = configurations
            .patch("sample_server", revision, patch)
            .await
            .unwrap();
        assert!(masked.compatible);
        assert_eq!(masked.values["local_manifest"], "********");
        assert_eq!(
            service.requires_configuration(&next).await.unwrap(),
            required
        );
    }
    // 每个必填声明独立满足，不能用一个来源填值绕过另一个必填输入。
    let mut token = next.requirements[0].clone();
    token.config_pointer = "/token".into();
    token.any_of.clear();
    next.requirements.push(token);
    assert!(service.requires_configuration(&next).await.unwrap());
    configurations
        .patch("sample_server", 3, json!({"token":"present"}))
        .await
        .unwrap();
    assert!(!service.requires_configuration(&next).await.unwrap());
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

#[tokio::test]
async fn startup_skips_blocked_release_and_keeps_enabled_intent() {
    let mut blocked = release("feature", 'a');
    blocked.enabled = true;
    blocked.status = InstallationStatus::RecoveryBlocked;
    blocked.failure = Some(InstallationFailure {
        phase: "transaction_rollback_cleanup".into(),
        reason: "测试恢复受阻".into(),
    });
    let (service, store, _) = setup(release("feature", 'b'), Some(blocked.clone()));
    service.restore().await.unwrap();
    let current = store.get("feature").await.unwrap();
    assert!(current.enabled);
    assert_eq!(current.status, InstallationStatus::RecoveryBlocked);
    assert!(
        service
            .set_enabled(current.id, current.revision, false)
            .await
            .is_err()
    );
    assert!(
        service
            .install(source(), Some(blocked.revision))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cancelled_queued_mutations_do_not_write_after_lifecycle_gate_opens() {
    use std::{future::Future, task::Poll};

    let old = release("feature", 'a');
    let (service, store, _) = setup(release("feature", 'b'), Some(old.clone()));
    for operation in 0..3 {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let plugins = service.plugins.clone();
        let blocker = tokio::spawn(async move {
            plugins
                .serialized(move |_| async move {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        entered_rx.await.unwrap();
        let cancel = CancellationToken::new();
        let queued_cancel = cancel.clone();
        let id = old.id.clone();
        let revision = old.revision.clone();
        let queued_service = service.clone();
        let mut queued = Box::pin(async move {
            match operation {
                0 => queued_service
                    .set_enabled_cancelled(id, revision, true, queued_cancel)
                    .await
                    .map(|_| ()),
                1 => queued_service
                    .delete_cancelled(id, revision, queued_cancel)
                    .await
                    .map(|_| ()),
                _ => queued_service
                    .cleanup_resources_cancelled(false, queued_cancel)
                    .await
                    .map(|_| ()),
            }
        });
        // 每轮只保留阻塞者和一个排队者，不改变生产准入上限。
        std::future::poll_fn(|context| {
            assert!(queued.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        cancel.cancel();
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        assert!(matches!(queued.await, Err(Error::Cancelled)));
    }
    let unchanged = store.get(&old.id).await.unwrap();
    assert!(!unchanged.enabled);
    assert_eq!(unchanged.revision, old.revision);
}

#[tokio::test]
async fn progress_storage_failure_after_commit_does_not_rollback_a_ready_release() {
    struct Reporter(Mutex<Vec<apk_domain::JobStage>>);
    #[async_trait]
    impl apk_domain::ProgressReporter for Reporter {
        async fn report(&self, progress: apk_domain::JobProgress) -> Result<()> {
            self.0.lock().unwrap().push(progress.stage);
            if matches!(
                progress.stage,
                apk_domain::JobStage::Activating | apk_domain::JobStage::Complete
            ) {
                Err(Error::Storage("模拟进度存储故障".into()))
            } else {
                Ok(())
            }
        }
    }
    let reporter = Arc::new(Reporter(Mutex::new(vec![])));
    let (service, store, _) = setup(release("feature", 'a'), None);
    let installed = service
        .install_with_progress(source(), None, CancellationToken::new(), reporter.clone())
        .await
        .unwrap();
    assert!(installed.enabled);
    assert_eq!(
        store.get("feature").await.unwrap().revision,
        installed.revision
    );
    assert_eq!(
        *reporter.0.lock().unwrap(),
        [
            apk_domain::JobStage::Preparing,
            apk_domain::JobStage::Deploying,
            apk_domain::JobStage::Activating,
            apk_domain::JobStage::Complete
        ]
    );
}

struct UnconfirmedExecutor;
#[async_trait]
impl apk_domain::Executor for UnconfirmedExecutor {
    fn operations(&self) -> Vec<apk_domain::Operation> {
        vec![apk_domain::Operation {
            id: "plugin.server.inspect".into(),
            title: "资源未确认夹具".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    fn has_unresolved_resources(&self) -> bool {
        true
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        Err(Error::CleanupFailed)
    }
}

#[tokio::test]
async fn historical_component_cleanup_warning_does_not_block_release_admission_or_idle_unload() {
    for historical_block in [false, true] {
        let mut old = release("feature", 'a');
        old.enabled = true;
        old.status = InstallationStatus::Enabled;
        old.components[0].kind = PackageKind::Server;
        old.components[0].id = "server".into();
        if historical_block {
            old.status = InstallationStatus::RecoveryBlocked;
            old.failure = Some(InstallationFailure {
                phase: "component_cleanup".into(),
                reason: "旧版历史清理告警".into(),
            });
        }
        let mut next = old.clone();
        next.version = "b".into();
        next.revision = "b".repeat(64);
        let (service, store, _) = setup(next, Some(old.clone()));
        service
            .plugins
            .seed(PluginContribution {
                id: "server".into(),
                version: "1".into(),
                executor: Arc::new(UnconfirmedExecutor),
            })
            .await
            .unwrap();
        service.require_recoverable(&old).unwrap();
        service.require_clean_components(&old).await.unwrap();
        assert!(service.plugins.list()[0].cleanup_failed);
        service
            .plugins
            .unload_idle_serialized("server")
            .await
            .unwrap();
        assert!(service.plugins.list().is_empty());
        let retained = store.get(&old.id).await.unwrap();
        assert_eq!(retained.status, old.status);
        assert_eq!(retained.revision, old.revision);
        assert_eq!(retained.version, old.version);
    }
}
