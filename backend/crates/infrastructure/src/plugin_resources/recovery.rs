//! 按清理标记的对象身份登记调用；保留锁与进程退出证据分别核对。
use super::ToolLease;
use apk_domain::{Error, Result};
use deviceforge_tool_repository::ReadLease;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak, atomic::AtomicBool},
};

const MAX_GROUPS: usize = 256;
const MAX_CALLS_PER_GROUP: usize = 64;
const MAX_CALLS: usize = 4096;

#[derive(Default)]
struct Registry {
    groups: HashMap<usize, Group>,
    calls: usize,
    next_call: u64,
    uncertain: bool,
}

struct Group {
    owner: Weak<AtomicBool>,
    calls: HashMap<u64, Debt>,
}

struct Debt {
    active: bool,
    process_exited: bool,
    retained: bool,
    reader: Option<ReadLease>,
}

fn registry() -> MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    match REGISTRY.get_or_init(Mutex::default).lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            // 台账内部异常不能转化为成功恢复，仍接收原调用的保留锁。
            guard.uncertain = true;
            guard
        }
    }
}

fn owner_key(unresolved: &Arc<AtomicBool>) -> usize {
    Arc::as_ptr(unresolved) as usize
}

impl Group {
    fn ready(&self) -> bool {
        self.calls
            .values()
            .all(|debt| !debt.active && debt.process_exited)
    }

    fn trace(&self) {
        tracing::warn!(
            recovery_debt_calls = self.calls.len(),
            recovery_debt_limit = MAX_CALLS_PER_GROUP,
            active_calls = self.calls.values().filter(|debt| debt.active).count(),
            pending_exits = self
                .calls
                .values()
                .filter(|debt| !debt.process_exited)
                .count(),
            retained_leases = self
                .calls
                .values()
                .filter(|debt| debt.reader.is_some())
                .count(),
            owner_alive = self.owner.strong_count() != 0,
            "插件工具租约恢复债务尚未确认"
        );
    }
}

pub(super) struct Call {
    group: usize,
    call: u64,
}

impl Call {
    pub(super) fn register(unresolved: &Arc<AtomicBool>) -> Result<Self> {
        let mut registry = registry();
        if registry.uncertain {
            return Err(Error::Storage("工具租约恢复台账状态未确认".into()));
        }
        let key = owner_key(unresolved);
        let group_calls = registry
            .groups
            .get(&key)
            .map_or(0, |group| group.calls.len());
        if group_calls >= MAX_CALLS_PER_GROUP
            || registry.calls >= MAX_CALLS
            || (!registry.groups.contains_key(&key) && registry.groups.len() >= MAX_GROUPS)
        {
            tracing::warn!(
                owner_calls = group_calls,
                owner_limit = MAX_CALLS_PER_GROUP,
                calls = registry.calls,
                call_limit = MAX_CALLS,
                groups = registry.groups.len(),
                group_limit = MAX_GROUPS,
                orphan_groups = registry
                    .groups
                    .values()
                    .filter(|group| group.owner.strong_count() == 0)
                    .count(),
                "工具租约恢复债务达到上限，拒绝启动新调用"
            );
            return Err(Error::Conflict(
                "工具租约恢复债务达到上限，请先核对未确认资源".into(),
            ));
        }
        let call = registry
            .next_call
            .checked_add(1)
            .ok_or_else(|| Error::Storage("工具租约调用编号已耗尽".into()))?;
        registry.next_call = call;
        let group = registry.groups.entry(key).or_insert_with(|| Group {
            // Weak 保持对象地址不被复用，但不反向持有插件 owner。
            owner: Arc::downgrade(unresolved),
            calls: HashMap::new(),
        });
        debug_assert!(group.owner.ptr_eq(&Arc::downgrade(unresolved)));
        group.calls.insert(
            call,
            Debt {
                active: true,
                process_exited: false,
                retained: false,
                reader: None,
            },
        );
        registry.calls += 1;
        Ok(Self { group: key, call })
    }

    pub(super) fn retain(&self) {
        let mut registry = registry();
        let group = registry
            .groups
            .get_mut(&self.group)
            .expect("调用仍持有租约登记");
        group
            .calls
            .get_mut(&self.call)
            .expect("调用仍在台账中")
            .retained = true;
        group.trace();
    }

    pub(super) fn process_exited(&self) {
        let mut registry = registry();
        let group = registry
            .groups
            .get_mut(&self.group)
            .expect("进程仍持有租约登记");
        group
            .calls
            .get_mut(&self.call)
            .expect("进程仍在台账中")
            .process_exited = true;
    }

    pub(super) fn release(&self, reader: Option<ReadLease>) {
        let mut registry = registry();
        let uncertain = registry.uncertain;
        let group = registry
            .groups
            .get_mut(&self.group)
            .expect("释放前保留租约登记");
        let debt = group.calls.get_mut(&self.call).expect("释放前保留调用登记");
        if debt.retained || uncertain {
            debt.reader = reader;
            debt.retained = true;
            debt.active = false;
            group.trace();
        } else {
            group.calls.remove(&self.call);
            if group.calls.is_empty() {
                registry.groups.remove(&self.group);
            }
            registry.calls -= 1;
            // 文件锁在台账互斥之外关闭，不扩大登记临界区。
            drop(registry);
            drop(reader);
        }
    }
}

/// 仅交给公共工具进程所有者；正常释放表示未启动或真实 wait/reap 已确认。
pub(crate) struct ProcessLease(pub(super) Arc<ToolLease>);

impl Drop for ProcessLease {
    fn drop(&mut self) {
        // 公共执行器在回收失败/运行时丢失时保守保留此对象，不会走到这里。
        self.0.process_exited();
    }
}

pub(crate) fn recovery_ready(unresolved: &Arc<AtomicBool>) -> bool {
    let registry = registry();
    !registry.uncertain
        && registry
            .groups
            .get(&owner_key(unresolved))
            .is_none_or(Group::ready)
}

/// 调用者须冻结 owner、取得全量外部确认，并在清风险前复核其修订号。
pub(crate) fn confirm_recovery(unresolved: &Arc<AtomicBool>) -> Result<()> {
    let mut registry = registry();
    if registry.uncertain {
        return Err(Error::Storage("工具租约恢复台账状态未确认".into()));
    }
    let key = owner_key(unresolved);
    if registry
        .groups
        .get(&key)
        .is_some_and(|group| !group.ready())
    {
        return Err(Error::Conflict(
            "旧插件调用仍活动或直接进程退出尚未确认".into(),
        ));
    }
    let group = registry.groups.remove(&key);
    if let Some(group) = &group {
        registry.calls -= group.calls.len();
    }
    drop(registry);
    // 只释放本次身份的保留锁；不修改 unresolved，也不碰其他 owner 或活动调用。
    drop(group);
    Ok(())
}
