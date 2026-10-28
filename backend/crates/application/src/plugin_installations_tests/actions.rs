//! 整套管理用例的直接单元；不以模拟贡献代替浏览器和真实设备验收。
use super::*;
use apk_domain::{ExecutionContext, Executor};

#[tokio::test]
async fn installation_restore_successful_does_not_treat_arbitrary_previous_as_success() {
    let old = release("feature", 'a');
    let current = release("feature", 'b');
    let (service, store, _) = setup(current.clone(), Some(current.clone()));
    *store.previous.lock().unwrap() = Some(old.clone());
    assert!(
        service
            .restore_previous_successful(
                current.id.clone(),
                current.revision.clone(),
                CancellationToken::new(),
                Default::default()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get("feature").await.unwrap().revision,
        current.revision
    );
    let mut activated = old;
    activated.enabled = true;
    activated.status = InstallationStatus::Enabled;
    store.successful.lock().unwrap().push(SuccessfulRelease {
        release: activated,
        activated_at: 1,
        scope: SuccessfulReleaseScope::HostActivation,
    });
    let restored = service
        .restore_previous_successful(
            current.id,
            current.revision,
            CancellationToken::new(),
            Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(restored.revision, "a".repeat(64));
    assert!(!restored.enabled);
}

#[tokio::test]
async fn installation_successful_restore_preserves_enabled_intent_when_configuration_is_missing() {
    let mut current = release("feature", 'b');
    current.enabled = true;
    current.status = InstallationStatus::Enabled;
    let (service, store, _) = setup(current.clone(), Some(current.clone()));
    let mut old = release("feature", 'a');
    old.enabled = true;
    old.status = InstallationStatus::Enabled;
    old.requirements.push(ReleaseRequirement {
        component_id: "sample_browser".into(),
        config_pointer: "/account".into(),
        any_of: vec![],
        required: true,
        title: "账号".into(),
        description: "必填账号".into(),
        sensitive: false,
    });
    store.successful.lock().unwrap().push(SuccessfulRelease {
        release: old,
        activated_at: 1,
        scope: SuccessfulReleaseScope::HostActivation,
    });
    let restored = service
        .restore_previous_successful(
            current.id,
            current.revision,
            CancellationToken::new(),
            Default::default(),
        )
        .await
        .unwrap();
    assert!(restored.enabled);
    assert_eq!(restored.status, InstallationStatus::ConfigurationRequired);
}

#[tokio::test]
async fn installation_reload_and_restore_respect_original_deadline_cancel_revision_and_confirmation()
 {
    let mut current = release("feature", 'a');
    current.enabled = true;
    current.status = InstallationStatus::Enabled;
    let (service, store, _) = setup(current.clone(), Some(current.clone()));
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        service
            .reload(
                current.id.clone(),
                current.revision.clone(),
                cancelled,
                Default::default()
            )
            .await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        service
            .reload(
                current.id.clone(),
                current.revision.clone(),
                CancellationToken::new(),
                ExecutionContext {
                    deadline: Some(std::time::Instant::now())
                }
            )
            .await,
        Err(Error::Timeout)
    ));
    assert!(
        service
            .reload(
                current.id.clone(),
                "b".repeat(64),
                CancellationToken::new(),
                Default::default()
            )
            .await
            .is_err()
    );
    let operations = crate::installation_operations::InstallationOperations::default();
    operations.bind(service).unwrap();
    for name in ["installation.reload", "installation.restore_successful"] {
        let operation = operations
            .operations()
            .into_iter()
            .find(|operation| operation.id == name)
            .unwrap();
        assert_eq!(operation.execution.unwrap().total_timeout_ms, 30_000);
        assert!(
            operations
                .execute(
                    name,
                    json!({"id":"feature","expected_revision":current.revision,"confirmed":false}),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
    }
    assert_eq!(
        store.get("feature").await.unwrap().revision,
        current.revision
    );
}

#[tokio::test]
async fn installation_reload_queue_wait_expires_without_late_activation() {
    let mut current = release("feature", 'a');
    current.enabled = true;
    current.status = InstallationStatus::Enabled;
    let (service, store, _) = setup(current.clone(), Some(current.clone()));
    let plugins = service.plugins.clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let leave = Arc::new(tokio::sync::Notify::new());
    let work_entered = entered.clone();
    let work_leave = leave.clone();
    let blocker = tokio::spawn(async move {
        plugins
            .serialized(move |_| async move {
                work_entered.notify_one();
                work_leave.notified().await;
                Ok(())
            })
            .await
    });
    entered.notified().await;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        service.reload(
            current.id.clone(),
            current.revision.clone(),
            CancellationToken::new(),
            ExecutionContext {
                deadline: Some(std::time::Instant::now() + std::time::Duration::from_millis(30)),
            },
        ),
    )
    .await;
    // 先释放测试门禁，即使断言失败也不遗留测试任务。
    leave.notify_one();
    blocker.await.unwrap().unwrap();
    assert!(matches!(result, Ok(Err(Error::Timeout))));
    service
        .plugins
        .serialized(|_| async { Ok(()) })
        .await
        .unwrap();
    assert!(store.successful.lock().unwrap().is_empty());
    assert_eq!(
        store.get("feature").await.unwrap().revision,
        current.revision
    );
}

struct Echo(String);
#[async_trait]
impl Executor for Echo {
    fn operations(&self) -> Vec<apk_domain::Operation> {
        vec![apk_domain::Operation {
            id: format!("plugin.{}.echo", self.0),
            title: "回显".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        Ok(input)
    }
}
struct Catalog;
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: Arc::new(Echo(id.into())),
        })
    }
}

#[tokio::test]
async fn installation_reload_replaces_whole_owned_server_group_without_enabling_disabled_release() {
    let mut current = release("feature", 'a');
    current.components = ["one", "two"]
        .into_iter()
        .map(|id| InstalledComponent {
            id: id.into(),
            kind: PackageKind::Server,
            version: "1".into(),
            revision: current.revision.clone(),
            entry_path: "plugin.exe".into(),
            entry_url: None,
        })
        .collect();
    current.enabled = true;
    current.status = InstallationStatus::Enabled;
    let (_, store, configurations) = setup(current.clone(), Some(current.clone()));
    let app = crate::Application::new(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let plugins = PluginService::new(app.clone(), Arc::new(Catalog), Default::default());
    plugins.bind_installations(store.clone()).unwrap();
    for id in ["one", "two"] {
        plugins.seed(Catalog.load(id).await.unwrap()).await.unwrap();
    }
    let previous = plugins.list();
    let service = InstallationService::new(
        store.clone(),
        plugins.clone(),
        configurations.clone(),
        configurations,
    );
    let selected = previous.iter().find(|plugin| plugin.id == "one").unwrap();
    // 两次请求持有同一旧代，只能有一项在整套门禁内获准，第二项不能重载第一项的新代。
    let (first, second) = tokio::join!(
        service.reload_component_expected(
            "one".into(),
            selected.generation.clone(),
            CancellationToken::new(),
            Default::default()
        ),
        service.reload_component_expected(
            "one".into(),
            selected.generation.clone(),
            CancellationToken::new(),
            Default::default()
        ),
    );
    let result = match (first, second) {
        (Ok(value), Err(Error::Conflict(_))) | (Err(Error::Conflict(_)), Ok(value)) => value,
        other => panic!("旧代并发重载必须恰好一次成功：{other:?}"),
    };
    assert_eq!(result.id, "one");
    assert_ne!(result.generation, selected.generation);
    assert_eq!(
        store.get("feature").await.unwrap().revision,
        current.revision
    );
    assert_eq!(plugins.list().len(), 2);
    assert!(plugins.list().iter().all(|plugin| {
        previous
            .iter()
            .any(|old| old.id == plugin.id && old.generation != plugin.generation)
    }));
    assert!(plugins.load("one".into()).await.is_err());
    let generations: Vec<_> = plugins
        .list()
        .into_iter()
        .map(|plugin| (plugin.id, plugin.generation))
        .collect();
    assert!(matches!(
        service
            .reload_component_expected(
                "one".into(),
                selected.generation.clone(),
                CancellationToken::new(),
                Default::default()
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        plugins
            .list()
            .into_iter()
            .map(|plugin| (plugin.id, plugin.generation))
            .collect::<Vec<_>>(),
        generations
    );
    store
        .set_enabled(&current.id, &current.revision, false)
        .await
        .unwrap();
    assert!(
        service
            .reload(
                current.id,
                current.revision,
                CancellationToken::new(),
                Default::default()
            )
            .await
            .is_err()
    );
    app.shutdown().await.unwrap();
}
