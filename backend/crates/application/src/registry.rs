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
}
pub(crate) struct Owner {
    info: PluginInfo,
    executor: Arc<dyn Executor>,
    draining: AtomicBool,
    pub cancel: CancellationToken,
    pub tracker: TaskTracker,
    pub provider: Option<apk_domain::devices::DeviceProviderDefinition>,
}
impl Owner {
    pub fn info(&self) -> PluginInfo {
        let mut info = self.info.clone();
        info.cleanup_failed = self.executor.has_unresolved_resources();
        if self.draining.load(Ordering::Acquire) {
            info.state = PluginState::Draining;
        }
        info
    }
}
pub(crate) struct Snapshot {
    revision: u64,
    pub entries: BTreeMap<String, Arc<Registered>>,
    pub owners: BTreeMap<String, Arc<Owner>>,
    pub directories: BTreeMap<String,apk_domain::devices::DeviceDirectory>,
}
pub(crate) struct Registry(pub(crate) RwLock<Snapshot>);

fn prepare(
    executor: Arc<dyn Executor>,
    owner: Option<Arc<Owner>>,
    operations: Vec<Operation>,
) -> Result<BTreeMap<String, Arc<Registered>>> {
    let mut entries = BTreeMap::new();
    for operation in operations {
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
            }),
        );
    }
    if entries.len() > 4096 {
        return Err(Error::TooLarge);
    }
    Ok(entries)
}
impl Registry {
    pub fn new(executors: Vec<Arc<dyn Executor>>) -> Result<Self> {
        let mut snapshot = Snapshot {
            revision: 0,
            entries: BTreeMap::new(),
            owners: BTreeMap::new(),
            directories: BTreeMap::new(),
        };
        for executor in executors {
            let operations = executor.operations();
            let entries = prepare(executor, None, operations)?;
            if entries.keys().any(|id| snapshot.entries.contains_key(id)) {
                return Err(Error::Conflict("操作重复注册".into()));
            }
            snapshot.entries.extend(entries);
        }
        Ok(Self(RwLock::new(snapshot)))
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
}
impl Prepared {
    pub fn new(plugin: PluginContribution) -> Result<Self> {
        plugin_id(&plugin.id)?;
        if plugin.version.is_empty() || plugin.version.len() > 100 {
            return Err(Error::Invalid("插件版本必须是 1–100 字节".into()));
        }
        let operations = plugin.executor.operations();
        if operations.is_empty() {
            return Err(Error::Invalid("插件没有贡献操作".into()));
        }
        let provider = plugin.executor.device_provider();
        if let Some(definition) = &provider {
            crate::devices::rules::definition(definition,&operations,&plugin.id)?;
        }
        let owner = Arc::new(Owner {
            info: PluginInfo {
                id: plugin.id,
                version: plugin.version,
                generation: uuid::Uuid::new_v4().to_string(),
                state: PluginState::Loaded,
                operations: operations
                    .iter()
                    .map(|operation| operation.id.clone())
                    .collect(),
                protected: false,
                cleanup_failed: false,
            },
            executor: plugin.executor.clone(),
            draining: AtomicBool::new(false),
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
            provider,
        });
        let entries = prepare(plugin.executor, Some(owner.clone()), operations)?;
        Ok(Self { owner, entries })
    }
}
impl Registry {
    pub fn publish(&self, prepared: Prepared) -> Result<PluginInfo> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表发布异常".into()))?;
        if snapshot.owners.contains_key(&prepared.owner.info.id)
            || prepared
                .entries
                .keys()
                .any(|id| snapshot.entries.contains_key(id))
        {
            return Err(Error::Conflict(
                "插件或贡献已注册，排空期间也不能重载".into(),
            ));
        }
        if snapshot.owners.len() >= 256 || snapshot.entries.len() + prepared.entries.len() > 4096 {
            return Err(Error::Conflict("插件或操作目录容量已满".into()));
        }
        let revision = snapshot
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::Conflict("操作目录修订已耗尽".into()))?;
        let info = prepared.owner.info();
        snapshot.entries.extend(prepared.entries);
        snapshot.owners.insert(info.id.clone(), prepared.owner);
        snapshot.revision = revision;
        Ok(info)
    }
    pub fn detach(&self, id: &str) -> Result<Arc<Owner>> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表撤销异常".into()))?;
        let owner = snapshot
            .owners
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound("插件未加载".into()))?;
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
            owner.draining.store(true, Ordering::Release);
            owner.tracker.close();
            owner.cancel.cancel();
            snapshot.directories.remove(id);
            snapshot.revision = revision;
        }
        Ok(owner)
    }
    pub fn finish(&self, owner: &Arc<Owner>) -> Result<PluginInfo> {
        if owner.executor.has_unresolved_resources() {
            return Err(Error::CleanupFailed);
        }
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("注册表排空异常".into()))?;
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
}
