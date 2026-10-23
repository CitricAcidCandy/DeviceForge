//! 注册快照与插件代际；模式编译在调用者的受限工作池，发布只持有短时锁。
use crate::registration;
use apk_domain::{Error, Executor, Operation, Result, plugins::*};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Registered {
    pub operation: Operation,
    pub executor: Arc<dyn Executor>,
    pub validator: jsonschema::Validator,
    pub owner: Option<Arc<Owner>>,
    pub target: Option<Arc<Registered>>,
    pub binding: Option<Arc<crate::operation_aliases::Binding>>,
}
pub(crate) struct Owner {
    info: PluginInfo,
    pub(crate) executor: Arc<dyn Executor>,
    draining: AtomicBool,
    unresolved: AtomicBool,
    pub(crate) risk_revision: std::sync::atomic::AtomicU64,
    pub(crate) recovering: AtomicBool,
    pub(crate) recovery_admission: std::sync::Mutex<()>,
    pub(crate) recovery_report:
        std::sync::Mutex<Option<apk_domain::plugin_recovery::RecoveryReport>>,
    pub cancel: CancellationToken,
    pub tracker: TaskTracker,
    pub provider: Option<apk_domain::devices::DeviceProviderDefinition>,
    pub performance: Option<apk_domain::performance::PerformanceSourceDefinition>,
    pub session_provider: Option<Arc<dyn apk_domain::interactive::SessionProvider>>,
}
impl Owner {
    pub fn info(&self) -> PluginInfo {
        let mut info = self.info.clone();
        info.cleanup_failed = self.unresolved.load(Ordering::Acquire)
            || self.executor.has_unresolved_resources()
            || self
                .session_provider
                .as_ref()
                .is_some_and(|provider| provider.has_unresolved_resources());
        if self.draining.load(Ordering::Acquire) {
            info.state = PluginState::Draining;
        }
        info
    }
    pub(crate) fn mark_unresolved(&self) {
        let _gate = self
            .recovery_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.risk_revision.fetch_add(1, Ordering::AcqRel);
        self.unresolved.store(true, Ordering::Release);
    }
    pub(crate) fn confirm_recovery(&self, expected: u64) -> bool {
        let _gate = self
            .recovery_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.risk_revision.load(Ordering::Acquire) != expected {
            return false;
        }
        self.unresolved.store(false, Ordering::Release);
        true
    }
    pub(crate) fn claim(&self) -> Result<tokio_util::task::task_tracker::TaskTrackerToken> {
        let _gate = self
            .recovery_admission
            .lock()
            .map_err(|_| Error::Storage("插件资源准入异常".into()))?;
        if self.recovering.load(Ordering::Acquire) {
            return Err(Error::Conflict("插件正在核对资源".into()));
        }
        Ok(self.tracker.token())
    }
}
pub(crate) struct Snapshot {
    pub(crate) revision: u64,
    pub entries: BTreeMap<String, Arc<Registered>>,
    pub owners: BTreeMap<String, Arc<Owner>>,
    pub sessions: BTreeMap<String, Arc<crate::registry_sessions::RegisteredSession>>,
    pub directories: BTreeMap<String, apk_domain::devices::DeviceDirectory>,
    pub discovery_attempts: BTreeMap<String, std::sync::Weak<crate::devices::attempt::Attempt>>,
    pub discovery_started: BTreeMap<String, (String, String)>,
}
pub(crate) struct Registry(
    pub(crate) RwLock<Snapshot>,
    pub(crate) Arc<crate::operation_aliases::Config>,
    tokio::sync::watch::Sender<u64>,
);

fn prepare(
    executor: Arc<dyn Executor>,
    owner: Option<Arc<Owner>>,
    operations: Vec<Operation>,
) -> Result<BTreeMap<String, Arc<Registered>>> {
    let mut entries = BTreeMap::new();
    let provider = executor.device_provider();
    for operation in operations {
        let sampling = owner
            .as_ref()
            .and_then(|owner| owner.performance.as_ref())
            .is_some_and(|source| source.operation == operation.id);
        let operation = if sampling {
            // 声明已校验；采样与设备能力由自己的预算裁定，不填普通默认预算。
            operation
        } else {
            crate::operation_budget::registered(operation, provider.as_ref())?
        };
        if entries.contains_key(&operation.id) {
            return Err(Error::Conflict("操作重复注册".into()));
        }
        if let Some(owner) = &owner
            && !operation
                .id
                .starts_with(&format!("plugin.{}.", owner.info.id))
        {
            return Err(Error::Invalid("插件贡献不得越过自己的命名空间".into()));
        }
        let validator = registration::compile(&operation)?;
        entries.insert(
            operation.id.clone(),
            Arc::new(Registered {
                operation,
                executor: executor.clone(),
                validator,
                owner: owner.clone(),
                target: None,
                binding: None,
            }),
        );
    }
    if entries.len() > 4096 {
        return Err(Error::TooLarge);
    }
    Ok(entries)
}
impl Registry {
    #[cfg(test)]
    pub fn new(executors: Vec<Arc<dyn Executor>>) -> Result<Self> {
        Self::new_with_bindings(executors, Default::default())
    }
    pub fn new_with_bindings(
        executors: Vec<Arc<dyn Executor>>,
        bindings: crate::operation_aliases::Config,
    ) -> Result<Self> {
        bindings.validate()?;
        for binding in &bindings.bindings {
            // 即使目标尚未部署，也在启动阶段拒绝无效旧入口模式。
            registration::compile(&binding.operation)?;
        }
        let mut snapshot = Snapshot {
            revision: 0,
            entries: BTreeMap::new(),
            owners: BTreeMap::new(),
            sessions: BTreeMap::new(),
            directories: BTreeMap::new(),
            discovery_attempts: BTreeMap::new(),
            discovery_started: BTreeMap::new(),
        };
        for executor in executors {
            // 显式部署绑定预留入口；目标未加载时不回退旧内置执行器。
            let operations = executor
                .operations()
                .into_iter()
                .filter(|operation| {
                    !bindings
                        .bindings
                        .iter()
                        .any(|binding| binding.operation.id == operation.id)
                })
                .collect();
            let entries = prepare(executor, None, operations)?;
            if entries.keys().any(|id| snapshot.entries.contains_key(id)) {
                return Err(Error::Conflict("操作重复注册".into()));
            }
            snapshot.entries.extend(entries);
        }
        let (changes, _) = tokio::sync::watch::channel(snapshot.revision);
        Ok(Self(RwLock::new(snapshot), Arc::new(bindings), changes))
    }
    pub(crate) fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.2.subscribe()
    }
    pub fn operations(&self) -> (u64, Vec<Operation>) {
        let snapshot = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            snapshot.revision,
            snapshot
                .entries
                .values()
                .map(|entry| entry.operation.clone())
                .collect(),
        )
    }
    pub fn find(&self, id: &str) -> Result<Arc<Registered>> {
        self.0
            .read()
            .map_err(|_| Error::Storage("注册表读取异常".into()))?
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(id.into()))
    }
    pub fn current(&self, id: &str, registered: &Arc<Registered>) -> Result<bool> {
        Ok(self
            .0
            .read()
            .map_err(|_| Error::Storage("注册表读取异常".into()))?
            .entries
            .get(id)
            .is_some_and(|entry| Arc::ptr_eq(entry, registered)))
    }
    /// 短时资格判断与卸载排序；回调不得执行存储或其他阻塞副作用。
    pub(crate) fn with_current<T>(
        &self,
        registered: &Arc<Registered>,
        claim: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("提交资格注册表异常".into()))?;
        if !snapshot
            .entries
            .get(&registered.operation.id)
            .is_some_and(|entry| Arc::ptr_eq(entry, registered))
        {
            return Err(Error::Conflict("成功结果属于已撤销的操作代际".into()));
        }
        claim()
    }
    pub fn plugins(&self) -> Vec<PluginInfo> {
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owners
            .values()
            .map(|owner| owner.info())
            .collect()
    }
}

pub(crate) struct Prepared {
    owner: Arc<Owner>,
    entries: BTreeMap<String, Arc<Registered>>,
    sessions: BTreeMap<String, Arc<crate::registry_sessions::RegisteredSession>>,
}
impl Prepared {
    #[cfg(test)]
    pub fn new(plugin: PluginContribution) -> Result<Self> {
        Self::new_with_bindings(plugin, &Default::default())
    }
    pub fn new_with_bindings(
        plugin: PluginContribution,
        bindings: &crate::operation_aliases::Config,
    ) -> Result<Self> {
        plugin_id(&plugin.id)?;
        if plugin.version.is_empty() || plugin.version.len() > 100 {
            return Err(Error::Invalid("插件版本必须是 1–100 字节".into()));
        }
        let operations = plugin.executor.operations();
        let session_provider = plugin.executor.session_provider();
        let definitions = session_provider
            .as_ref()
            .map(|provider| provider.definitions())
            .unwrap_or_default();
        let provider = plugin.executor.device_provider();
        if let Some(definition) = &provider {
            crate::devices::rules::definition(definition, &operations, &plugin.id)?;
        }
        let performance = plugin.executor.performance_source();
        if let Some(definition) = &performance {
            definition.validate(&plugin.id, &operations, provider.as_ref())?;
        }
        let owner = Arc::new(Owner {
            info: PluginInfo {
                id: plugin.id.clone(),
                version: plugin.version,
                metadata: plugin.executor.plugin_metadata(),
                generation: uuid::Uuid::new_v4().to_string(),
                state: PluginState::Loaded,
                operations: operations
                    .iter()
                    .map(|operation| operation.id.clone())
                    .chain(
                        bindings
                            .bindings
                            .iter()
                            .filter(|binding| binding.plugin_id() == plugin.id)
                            .map(|binding| binding.operation.id.clone()),
                    )
                    .collect(),
                sessions: definitions
                    .iter()
                    .map(|definition| definition.id.clone())
                    .collect(),
                protected: false,
                cleanup_failed: false,
            },
            executor: plugin.executor.clone(),
            draining: AtomicBool::new(false),
            unresolved: AtomicBool::new(false),
            risk_revision: std::sync::atomic::AtomicU64::new(0),
            recovering: AtomicBool::new(false),
            recovery_admission: std::sync::Mutex::new(()),
            recovery_report: std::sync::Mutex::new(None),
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
            provider,
            performance,
            session_provider,
        });
        let mut entries = prepare(plugin.executor, Some(owner.clone()), operations)?;
        crate::registry_aliases::prepare(&mut entries, &owner, bindings)?;
        let sessions = crate::registry_sessions::prepare(
            owner.session_provider.as_ref(),
            &owner,
            definitions,
        )?;
        if entries.is_empty() && sessions.is_empty() {
            return Err(Error::Invalid("插件没有贡献操作或会话".into()));
        }
        if sessions.keys().any(|id| entries.contains_key(id)) {
            return Err(Error::Conflict("普通操作与会话贡献名称重复".into()));
        }
        Ok(Self {
            owner,
            entries,
            sessions,
        })
    }
}
impl Registry {
    pub fn validate_replacement(&self, id: &str, prepared: &Prepared) -> Result<()> {
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("注册表替换验证异常".into()))?;
        let owner = snapshot
            .owners
            .get(id)
            .ok_or_else(|| Error::NotFound("插件未加载".into()))?;
        if owner.recovering.load(Ordering::Acquire) {
            return Err(Error::Conflict("插件正在核对资源，暂不能卸载或替换".into()));
        }
        if prepared.owner.info.id != id {
            return Err(Error::Invalid("重载插件身份不一致".into()));
        }
        let foreign_entry = |name: &String| {
            snapshot.entries.get(name).is_some_and(|entry| {
                !entry
                    .owner
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, owner))
            }) || snapshot
                .sessions
                .get(name)
                .is_some_and(|entry| !Arc::ptr_eq(&entry.owner, owner))
        };
        if prepared
            .entries
            .keys()
            .chain(prepared.sessions.keys())
            .any(foreign_entry)
        {
            return Err(Error::Conflict("重载贡献与其他插件或内置操作冲突".into()));
        }
        let old_entries = snapshot
            .entries
            .values()
            .filter(|entry| {
                entry
                    .owner
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, owner))
            })
            .count()
            + snapshot
                .sessions
                .values()
                .filter(|entry| Arc::ptr_eq(&entry.owner, owner))
                .count();
        if snapshot.entries.len() + snapshot.sessions.len() - old_entries
            + prepared.entries.len()
            + prepared.sessions.len()
            > 4096
            || snapshot.revision > u64::MAX - 2
        {
            return Err(Error::Conflict("重载超过操作目录容量或修订上限".into()));
        }
        Ok(())
    }
    pub fn publish(&self, prepared: Prepared) -> Result<PluginInfo> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表发布异常".into()))?;
        if snapshot.owners.contains_key(&prepared.owner.info.id)
            || prepared
                .entries
                .keys()
                .chain(prepared.sessions.keys())
                .any(|id| snapshot.entries.contains_key(id) || snapshot.sessions.contains_key(id))
        {
            return Err(Error::Conflict(
                "插件或贡献已注册，排空期间也不能重载".into(),
            ));
        }
        if snapshot.owners.len() >= 256
            || snapshot.entries.len()
                + snapshot.sessions.len()
                + prepared.entries.len()
                + prepared.sessions.len()
                > 4096
        {
            return Err(Error::Conflict("插件或操作目录容量已满".into()));
        }
        let revision = snapshot
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::Conflict("操作目录修订已耗尽".into()))?;
        let info = prepared.owner.info();
        snapshot.entries.extend(prepared.entries);
        snapshot.sessions.extend(prepared.sessions);
        snapshot.owners.insert(info.id.clone(), prepared.owner);
        snapshot.revision = revision;
        self.2.send_replace(revision);
        Ok(info)
    }
    pub fn detach(&self, id: &str) -> Result<Arc<Owner>> {
        self.detach_checked(id, false)
    }
    pub fn detach_if_idle(&self, id: &str) -> Result<Arc<Owner>> {
        self.detach_checked(id, true)
    }
    fn detach_checked(&self, id: &str, require_idle: bool) -> Result<Arc<Owner>> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表撤销异常".into()))?;
        let owner = snapshot
            .owners
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound("插件未加载".into()))?;
        if owner.recovering.load(Ordering::Acquire) {
            return Err(Error::Conflict("插件正在核对资源，暂不能卸载或替换".into()));
        }
        if require_idle {
            if owner.info().cleanup_failed {
                return Err(Error::CleanupFailed);
            }
            if !owner.tracker.is_empty() || owner.draining.load(Ordering::Acquire) {
                return Err(Error::Conflict(
                    "插件仍有活动任务或会话，不能应用需要重载的配置".into(),
                ));
            }
        }
        if !owner.draining.load(Ordering::Acquire) {
            let revision = snapshot
                .revision
                .checked_add(1)
                .ok_or_else(|| Error::Conflict("操作目录修订已耗尽".into()))?;
            snapshot.entries.retain(|_, entry| {
                !entry
                    .owner
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, &owner))
            });
            snapshot
                .sessions
                .retain(|_, entry| !Arc::ptr_eq(&entry.owner, &owner));
            owner.draining.store(true, Ordering::Release);
            owner.tracker.close();
            owner.cancel.cancel();
            snapshot.directories.remove(id);
            snapshot.discovery_started.remove(id);
            snapshot.discovery_attempts.retain(|_, weak| {
                let Some(attempt) = weak.upgrade() else {
                    return false;
                };
                if Arc::ptr_eq(&attempt.owner, &owner) {
                    // registry→gate；取消token由owner撤销统一传播。
                    let mut state = attempt
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if matches!(state.decision, crate::devices::attempt::Decision::Pending) {
                        state.decision = crate::devices::attempt::Decision::Cancelled(
                            crate::devices::attempt::Rejection::Conflict,
                        );
                    }
                }
                true
            });
            snapshot.revision = revision;
            self.2.send_replace(revision);
        }
        Ok(owner)
    }
    pub fn finish(&self, owner: &Arc<Owner>) -> Result<PluginInfo> {
        if owner.info().cleanup_failed {
            return Err(Error::CleanupFailed);
        }
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表排空异常".into()))?;
        if owner.recovering.load(Ordering::Acquire) {
            return Err(Error::Conflict(
                "插件正在核对资源，排空完成需等待恢复结束".into(),
            ));
        }
        if snapshot
            .owners
            .get(&owner.info.id)
            .is_some_and(|value| Arc::ptr_eq(value, owner))
        {
            snapshot.owners.remove(&owner.info.id);
        }
        let mut info = owner.info();
        info.state = PluginState::Unloaded;
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::{Value, json};
    struct Echo;
    #[async_trait]
    impl Executor for Echo {
        fn operations(&self) -> Vec<Operation> {
            vec![Operation {
                execution: None,
                id: "plugin.test.echo".into(),
                title: "回显".into(),
                input_schema: json!({"type":"object"}),
            }]
        }
        async fn execute(&self, _: &str, value: Value, _: CancellationToken) -> Result<Value> {
            Ok(value)
        }
    }
    fn prepared() -> Prepared {
        Prepared::new(PluginContribution {
            id: "test".into(),
            version: "1".into(),
            executor: Arc::new(Echo),
        })
        .unwrap()
    }
    struct DescribedEcho(&'static str);
    #[async_trait]
    impl Executor for DescribedEcho {
        fn operations(&self) -> Vec<Operation> {
            Echo.operations()
        }
        fn plugin_metadata(&self) -> Option<PluginDisplayMetadata> {
            Some(PluginDisplayMetadata {
                name: self.0.into(),
                summary: "测试插件展示信息".into(),
                description: "展示信息不改变操作贡献和插件身份。".into(),
            })
        }
        async fn execute(&self, _: &str, value: Value, _: CancellationToken) -> Result<Value> {
            Ok(value)
        }
    }

    #[test]
    fn plugin_metadata_belongs_to_registration_generation_and_is_optional_for_legacy_executors() {
        let registry = Registry::new(vec![]).unwrap();
        let legacy = registry.publish(prepared()).unwrap();
        assert!(legacy.metadata.is_none());
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("metadata")
                .is_none()
        );
        let owner = registry.detach("test").unwrap();
        registry.finish(&owner).unwrap();
        let described = Prepared::new(PluginContribution {
            id: "test".into(),
            version: "1".into(),
            executor: Arc::new(DescribedEcho("回显工具")),
        })
        .unwrap();
        let loaded = registry.publish(described).unwrap();
        assert_eq!(loaded.metadata.as_ref().unwrap().name, "回显工具");
        assert_ne!(loaded.generation, legacy.generation);
        assert_eq!(
            registry.plugins()[0].metadata.as_ref().unwrap().name,
            "回显工具"
        );
        let owner = registry.detach("test").unwrap();
        assert_eq!(owner.info().metadata.as_ref().unwrap().name, "回显工具");
        let unloaded = registry.finish(&owner).unwrap();
        assert_eq!(unloaded.metadata.as_ref().unwrap().name, "回显工具");
        registry.publish(prepared()).unwrap();
        assert!(registry.plugins()[0].metadata.is_none());
    }

    #[test]
    fn old_snapshot_cannot_pass_admission_after_same_id_reloads() {
        let registry = Registry::new(vec![]).unwrap();
        registry.publish(prepared()).unwrap();
        let old = registry.find("plugin.test.echo").unwrap();
        assert!(registry.current("plugin.test.echo", &old).unwrap());
        let owner = registry.detach("test").unwrap();
        assert!(matches!(
            registry.publish(prepared()),
            Err(Error::Conflict(_))
        ));
        registry.finish(&owner).unwrap();
        registry.publish(prepared()).unwrap();
        assert!(!registry.current("plugin.test.echo", &old).unwrap());
        assert_eq!(registry.operations().0, 3);
    }

    #[test]
    fn contribution_watch_tracks_publication_and_first_detach_only() {
        let registry = Registry::new(vec![]).unwrap();
        let mut changes = registry.subscribe();
        assert_eq!(*changes.borrow_and_update(), 0);
        registry.publish(prepared()).unwrap();
        assert!(changes.has_changed().unwrap());
        assert_eq!(*changes.borrow_and_update(), registry.operations().0);
        assert!(matches!(
            registry.publish(prepared()),
            Err(Error::Conflict(_))
        ));
        assert!(!changes.has_changed().unwrap());
        let owner = registry.detach("test").unwrap();
        assert_eq!(*changes.borrow_and_update(), 2);
        registry.detach("test").unwrap();
        registry.finish(&owner).unwrap();
        assert!(!changes.has_changed().unwrap());
        registry.publish(prepared()).unwrap();
        assert_eq!(*changes.borrow_and_update(), 3);
    }

    #[test]
    fn contribution_watch_coalesces_changes_and_seeds_late_subscribers() {
        let registry = Registry::new(vec![]).unwrap();
        let mut existing = registry.subscribe();
        registry.publish(prepared()).unwrap();
        let owner = registry.detach("test").unwrap();
        registry.finish(&owner).unwrap();
        registry.publish(prepared()).unwrap();
        assert_eq!(*existing.borrow_and_update(), 3);
        assert!(!existing.has_changed().unwrap());
        let late = registry.subscribe();
        assert_eq!(*late.borrow(), 3);
        assert!(!late.has_changed().unwrap());
        drop(existing);
        drop(late);
        let owner = registry.detach("test").unwrap();
        registry.finish(&owner).unwrap();
        assert_eq!(*registry.subscribe().borrow(), 4);
    }

    struct PerformanceEcho {
        foreign: bool,
    }
    #[async_trait]
    impl Executor for PerformanceEcho {
        fn operations(&self) -> Vec<Operation> {
            Echo.operations()
        }
        fn performance_source(
            &self,
        ) -> Option<apk_domain::performance::PerformanceSourceDefinition> {
            Some(apk_domain::performance::PerformanceSourceDefinition {
                api_version: 1,
                operation: if self.foreign {
                    "plugin.other.echo"
                } else {
                    "plugin.test.echo"
                }
                .into(),
                fps: false,
                device_observation: false,
                partial_metrics: false,
                device_capability: None,
            })
        }
        async fn execute(&self, _: &str, value: Value, _: CancellationToken) -> Result<Value> {
            Ok(value)
        }
    }
    fn performance(foreign: bool) -> Result<Prepared> {
        Prepared::new(PluginContribution {
            id: "test".into(),
            version: "1".into(),
            executor: Arc::new(PerformanceEcho { foreign }),
        })
    }

    #[test]
    fn invalid_custom_performance_source_cannot_publish_any_contribution() {
        let registry = Registry::new(vec![]).unwrap();
        assert!(matches!(performance(true), Err(Error::Invalid(_))));
        assert_eq!(registry.operations().0, 0);
        assert!(registry.operations().1.is_empty());
        assert!(registry.plugins().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn performance_owner_keeps_generation_and_sample_budget_without_ordinary_default() {
        let registry = Registry::new(vec![]).unwrap();
        let first = registry.publish(performance(false).unwrap()).unwrap();
        let registered = registry.find("plugin.test.echo").unwrap();
        assert!(registered.operation.execution.is_none());
        let owner = registered.owner.as_ref().unwrap();
        assert_eq!(owner.performance.as_ref().unwrap().api_version, 1);
        let admitted = tokio::time::Instant::now();
        assert_eq!(
            crate::operation_budget::deadline(&registered, admitted, None, None),
            Some(admitted + std::time::Duration::from_secs(10))
        );
        let parent = admitted + std::time::Duration::from_secs(5);
        assert_eq!(
            crate::operation_budget::deadline(&registered, admitted, None, Some(parent)),
            Some(parent)
        );
        let detached = registry.detach("test").unwrap();
        assert!(
            !registry
                .current(&registered.operation.id, &registered)
                .unwrap()
        );
        assert!(owner.cancel.is_cancelled());
        registry.finish(&detached).unwrap();
        let next = registry.publish(performance(false).unwrap()).unwrap();
        assert_ne!(first.generation, next.generation);
        assert_eq!(owner.info().generation, first.generation);
    }

    #[tokio::test]
    async fn application_cleanup_risk_stays_visible_and_blocks_execution_finish_and_reload() {
        let registry = Registry::new(vec![]).unwrap();
        registry.publish(performance(false).unwrap()).unwrap();
        let registered = registry.find("plugin.test.echo").unwrap();
        let owner = registered.owner.as_ref().unwrap();
        owner.mark_unresolved();
        assert!(registry.plugins()[0].cleanup_failed);
        assert!(matches!(
            crate::execution::execute(
                registered.executor.as_ref(),
                &registered.operation.id,
                json!({}),
                CancellationToken::new(),
                Some(owner),
                None
            )
            .await,
            Err(Error::Conflict(_))
        ));
        let detached = registry.detach("test").unwrap();
        assert!(matches!(
            registry.finish(&detached),
            Err(Error::CleanupFailed)
        ));
        assert!(matches!(
            registry.publish(performance(false).unwrap()),
            Err(Error::Conflict(_))
        ));
        assert_eq!(registry.plugins()[0].state, PluginState::Draining);
        assert!(registry.plugins()[0].cleanup_failed);
    }
}
