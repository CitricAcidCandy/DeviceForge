//! 按对象身份登记资源占用；已退出调用的外部债务只进入有界历史。
use super::ToolLease;
use apk_domain::{Error, Result};
use deviceforge_tool_repository::ReadLease;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak, atomic::AtomicBool},
};

const MAX_GROUPS: usize = 256;
const MAX_CALLS_PER_GROUP: usize = 64;
const MAX_CALLS: usize = 4096;
const MAX_HISTORY: usize = 4096;

#[path = "confirmation.rs"]
mod confirmation;

#[derive(Default)]
struct Registry {
    groups: HashMap<usize, Group>,
    calls: usize,
    next_call: u64,
    uncertain: bool,
    history: VecDeque<HistoricalCall>,
    compacted_history: u64,
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

struct HistoricalCall {
    owner: Weak<AtomicBool>,
    call: u64,
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

impl Registry {
    fn register(&mut self, unresolved: &Arc<AtomicBool>) -> Result<Call> {
        if self.uncertain {
            tracing::warn!("工具租约台账存在未确认诊断，独立调用仍按真实占用准入");
        }
        let key = owner_key(unresolved);
        let group_calls = self.groups.get(&key).map_or(0, |group| group.calls.len());
        if group_calls >= MAX_CALLS_PER_GROUP
            || self.calls >= MAX_CALLS
            || (!self.groups.contains_key(&key) && self.groups.len() >= MAX_GROUPS)
        {
            tracing::warn!(
                owner_calls = group_calls,
                owner_limit = MAX_CALLS_PER_GROUP,
                calls = self.calls,
                call_limit = MAX_CALLS,
                groups = self.groups.len(),
                group_limit = MAX_GROUPS,
                orphan_groups = self
                    .groups
                    .values()
                    .filter(|group| group.owner.strong_count() == 0)
                    .count(),
                "活动或退出未确认的工具租约达到上限，拒绝启动新调用"
            );
            return Err(Error::Conflict(
                "活动或退出未确认的工具租约达到上限，请等待回收".into(),
            ));
        }
        let call = self
            .next_call
            .checked_add(1)
            .ok_or_else(|| Error::Storage("工具租约调用编号已耗尽".into()))?;
        self.next_call = call;
        let group = self.groups.entry(key).or_insert_with(|| Group {
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
        self.calls += 1;
        Ok(Call { group: key, call })
    }

    fn record_history(&mut self, owner: Weak<AtomicBool>, call: u64) {
        if self.history.len() == MAX_HISTORY {
            let oldest = self.history.pop_front().expect("历史已达固定上限");
            self.compacted_history = self.compacted_history.saturating_add(1);
            tracing::warn!(
                oldest_call = oldest.call,
                compacted_history = self.compacted_history,
                history_limit = MAX_HISTORY,
                "已退出调用的旧外部债务折叠为未确认计数，未宣告外部资源已清理"
            );
        }
        self.history.push_back(HistoricalCall { owner, call });
    }

    fn finish_call(&mut self, key: usize, call: u64) -> Debt {
        let group = self.groups.get_mut(&key).expect("结束前保留调用组");
        let debt = group.calls.remove(&call).expect("结束前保留调用登记");
        debug_assert!(!debt.active && (!debt.retained || debt.process_exited));
        let owner = group.owner.clone();
        if group.calls.is_empty() {
            self.groups.remove(&key);
        }
        self.calls -= 1;
        if debt.retained {
            self.record_history(owner, call);
        }
        debt
    }
}

impl Call {
    pub(super) fn register(unresolved: &Arc<AtomicBool>) -> Result<Self> {
        registry().register(unresolved)
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
        let Some(group) = registry.groups.get_mut(&self.group) else {
            return;
        };
        let Some(debt) = group.calls.get_mut(&self.call) else {
            return;
        };
        debt.process_exited = true;
        let released = if !debt.active {
            Some(registry.finish_call(self.group, self.call))
        } else {
            None
        };
        drop(registry);
        // 晚到的系统退出凭据只释放这一调用的读锁，不清除外部风险。
        drop(released);
    }

    pub(super) fn release(&self, reader: Option<ReadLease>) {
        let mut registry = registry();
        let group = registry
            .groups
            .get_mut(&self.group)
            .expect("释放前保留租约登记");
        let debt = group.calls.get_mut(&self.call).expect("释放前保留调用登记");
        debt.active = false;
        if debt.retained && !debt.process_exited {
            debt.reader = reader;
            group.trace();
        } else {
            let released = registry.finish_call(self.group, self.call);
            // 文件锁在台账互斥之外关闭，不扩大登记临界区。
            drop(registry);
            drop(released);
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

/// 外部核对成功后，仅确认指定对象；后台恢复必须传入核对前取得的债务快照。
pub(crate) fn confirm_recovery(target: &impl confirmation::RecoveryConfirmation) -> Result<()> {
    target.confirm()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncertain_registry_warns_without_blocking_new_call_or_clearing_risk() {
        let mut registry = Registry {
            uncertain: true,
            ..Registry::default()
        };
        let owner = Arc::new(AtomicBool::new(true));
        registry.register(&owner).unwrap();
        assert!(registry.uncertain);
        assert_eq!(registry.calls, 1);
        assert!(owner.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn bounded_history_compacts_without_using_active_group_or_call_limits() {
        let mut registry = Registry::default();
        for call in 0..MAX_HISTORY as u64 + 3 {
            let owner = Arc::new(AtomicBool::new(true));
            registry.record_history(Arc::downgrade(&owner), call);
        }
        assert_eq!(registry.history.len(), MAX_HISTORY);
        assert_eq!(registry.compacted_history, 3);
        assert_eq!(registry.history.front().unwrap().call, 3);
        assert!(registry.groups.is_empty());
        assert_eq!(registry.calls, 0);
        registry
            .register(&Arc::new(AtomicBool::new(false)))
            .unwrap();
        assert_eq!(registry.calls, 1);
        assert_eq!(registry.compacted_history, 3);
    }

    #[test]
    fn scoped_confirmation_advances_old_history_without_erasing_pending_or_other_owner() {
        let owner = Arc::new(AtomicBool::new(true));
        let other = Arc::new(AtomicBool::new(true));
        for identity in [&owner, &other] {
            let old = ToolLease::new(None, identity).unwrap();
            old.retain();
            old.process_exited();
            drop(old);
        }
        let recovery = ToolLease::recovery_snapshot(&owner);
        let pending = Call::register(&owner).unwrap();
        pending.retain();
        pending.release(None);
        assert!(matches!(
            confirm_recovery(&recovery),
            Err(Error::Conflict(_))
        ));
        {
            let registry = registry();
            assert!(
                !registry
                    .history
                    .iter()
                    .any(|history| history.owner.ptr_eq(&Arc::downgrade(&owner)))
            );
            assert!(
                registry
                    .history
                    .iter()
                    .any(|history| history.owner.ptr_eq(&Arc::downgrade(&other)))
            );
            assert!(
                registry.groups[&owner_key(&owner)]
                    .calls
                    .contains_key(&pending.call)
            );
        }
        pending.process_exited();
        assert!(matches!(
            confirm_recovery(&recovery),
            Err(Error::Conflict(_))
        ));
        confirm_recovery(&ToolLease::recovery_snapshot(&owner)).unwrap();
        assert!(!owner.load(std::sync::atomic::Ordering::Acquire));
        assert!(other.load(std::sync::atomic::Ordering::Acquire));
        confirm_recovery(&other).unwrap();
    }
}
