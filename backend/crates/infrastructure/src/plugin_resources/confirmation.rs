//! 外部确认只覆盖核对前的历史快照；新调用与晚到旧退出始终保留各自归属。
use super::*;
use std::{collections::HashSet, sync::atomic::Ordering};

pub(crate) trait RecoveryConfirmation {
    fn confirm(&self) -> Result<()>;
}

pub(crate) struct RecoverySnapshot {
    owner: Weak<AtomicBool>,
    calls: HashSet<u64>,
    compacted_history: u64,
}

impl ToolLease {
    pub(crate) fn recovery_snapshot(unresolved: &Arc<AtomicBool>) -> RecoverySnapshot {
        let registry = registry();
        let owner = Arc::downgrade(unresolved);
        RecoverySnapshot {
            calls: registry
                .history
                .iter()
                .filter(|history| history.owner.ptr_eq(&owner))
                .map(|history| history.call)
                .collect(),
            owner,
            compacted_history: registry.compacted_history,
        }
    }
}

impl RecoveryConfirmation for RecoverySnapshot {
    fn confirm(&self) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| Error::Conflict("资源核对所属插件已释放".into()))?;
        let mut registry = registry();
        if registry.uncertain {
            return Err(Error::Storage("工具租约恢复台账状态未确认".into()));
        }
        registry.history.retain(|history| {
            !history.owner.ptr_eq(&self.owner) || !self.calls.contains(&history.call)
        });
        let group = registry.groups.get(&owner_key(&owner));
        let pending = group.is_some_and(|group| group.calls.values().any(|debt| debt.retained))
            || registry
                .history
                .iter()
                .any(|history| history.owner.ptr_eq(&self.owner));
        if pending {
            // 已核对历史仍可前进，但在途或核对期间新增的债务不能被旧报告冲销。
            return Err(Error::Conflict(
                "已核对旧资源；其他调用仍有活动、退出未确认或晚到清理债务".into(),
            ));
        }
        if group.is_none() && registry.compacted_history == self.compacted_history {
            // 与登记共用台账临界区；存在新活动调用时不清标记，避免覆盖其迟到失败。
            owner.store(false, Ordering::Release);
        }
        Ok(())
    }
}

// 保留全量排空调用者的确认语义；不把旧接口悄悄改成忽略真实进程占用。
impl RecoveryConfirmation for Arc<AtomicBool> {
    fn confirm(&self) -> Result<()> {
        let mut registry = registry();
        if registry.uncertain {
            return Err(Error::Storage("工具租约恢复台账状态未确认".into()));
        }
        let key = owner_key(self);
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
        let owner = Arc::downgrade(self);
        registry
            .history
            .retain(|history| !history.owner.ptr_eq(&owner));
        drop(registry);
        // 全量接口不直接清除外部风险；折叠计数也不冒充已清理。
        drop(group);
        Ok(())
    }
}
