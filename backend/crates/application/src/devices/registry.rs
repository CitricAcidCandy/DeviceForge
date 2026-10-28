//! 目录与贡献共享同一注册锁；发布复核代际，卸载原子撤销目录。
use super::attempt::{Attempt, Decision, Rejection};
use crate::registry::{Registered, Registry};
use apk_domain::{Error, Result, devices::*};
use std::sync::Arc;

impl Registry {
    pub fn providers(&self) -> Vec<DeviceProviderInfo> {
        let snapshot = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot
            .owners
            .values()
            .filter_map(|owner| super::rules::provider(owner))
            .collect()
    }
    pub fn directories(&self) -> Vec<DeviceDirectory> {
        let snapshot = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot
            .directories
            .values()
            .filter(|dir| {
                snapshot
                    .owners
                    .get(&dir.provider.id)
                    .and_then(|owner| super::rules::provider(owner))
                    .is_some_and(|provider| provider.generation == dir.provider.generation)
            })
            .cloned()
            .collect()
    }
    pub fn provider_operation(
        &self,
        id: &str,
        generation: &str,
        capability: Option<(&str, u32)>,
    ) -> Result<(DeviceProviderInfo, Arc<Registered>)> {
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("设备注册读取异常".into()))?;
        let provider = snapshot
            .owners
            .get(id)
            .and_then(|owner| super::rules::provider(owner))
            .ok_or_else(|| {
                Error::NotFound("设备插件尚未启用或已被移除，请先启用对应插件".into())
            })?;
        if provider.generation != generation {
            return Err(Error::Conflict(
                "设备插件已更新，当前设备信息已过期，请刷新页面后重新选择设备".into(),
            ));
        }
        let operation = match capability {
            None => &provider.definition.discover_operation,
            Some((id, version)) => {
                &provider
                    .definition
                    .capabilities
                    .iter()
                    .find(|cap| cap.id == id && cap.version == version)
                    .ok_or_else(|| {
                        Error::NotFound(
                            "当前设备插件不支持这项功能或所需版本，请检查插件是否已更新".into(),
                        )
                    })?
                    .operation
            }
        };
        let registered = snapshot.entries.get(operation).cloned().ok_or_else(|| {
            Error::Conflict("设备插件已停止提供这项功能，请更新设备列表后重试".into())
        })?;
        Ok((provider, registered))
    }
    #[cfg(test)]
    pub fn publish_directory(
        &self,
        directory: DeviceDirectory,
        cancel: &tokio_util::sync::CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<DeviceDirectory> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("设备目录发布异常".into()))?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let current = snapshot
            .owners
            .get(&directory.provider.id)
            .and_then(|owner| super::rules::provider(owner));
        if current.is_none_or(|current| current.generation != directory.provider.generation) {
            return Err(Error::Conflict(
                "获取设备列表时插件已更新，本次旧结果已忽略，请重新获取设备列表".into(),
            ));
        }
        snapshot
            .directories
            .insert(directory.provider.id.clone(), directory.clone());
        Ok(directory)
    }

    pub fn track_discovery(&self, attempt: &Arc<Attempt>) -> Result<()> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("发现注册异常".into()))?;
        snapshot
            .discovery_attempts
            .retain(|_, weak| weak.strong_count() > 0);
        snapshot
            .discovery_attempts
            .insert(attempt.job_id.clone(), Arc::downgrade(attempt));
        Ok(())
    }
    pub fn forget_discovery(&self, attempt: &Attempt) {
        let mut snapshot = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshot.discovery_attempts.remove(&attempt.job_id);
        if snapshot
            .discovery_started
            .get(&attempt.provider.id)
            .is_some_and(|(generation, job)| {
                generation == &attempt.provider.generation && job == &attempt.job_id
            })
        {
            snapshot.discovery_started.remove(&attempt.provider.id);
        }
    }
    /// 通过开始门禁后清旧目录；此决定与真实工具启动分开记录。
    pub fn begin_discovery(&self, attempt: &Attempt) -> Result<()> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("发现开始状态异常".into()))?;
        let mut state = attempt
            .state
            .lock()
            .map_err(|_| Error::Storage("发现裁定异常".into()))?;
        let result = attempt
            .check(&state)
            .and_then(|()| current_attempt(&snapshot, attempt));
        if let Err(error) = result {
            if matches!(state.decision, Decision::Pending) {
                state.decision = Decision::Cancelled(Rejection::from_error(&error));
            }
            return Err(error);
        }
        if state.started {
            return Err(Error::Conflict("发现开始门禁不可重复进入".into()));
        }
        state.started = true;
        snapshot.discovery_started.insert(
            attempt.provider.id.clone(),
            (attempt.provider.generation.clone(), attempt.job_id.clone()),
        );
        snapshot.directories.remove(&attempt.provider.id);
        tracing::info!(job_id = %attempt.job_id, "发现开始门禁已接受");
        Ok(())
    }
    pub fn accept_discovery(&self, attempt: &Attempt, directory: DeviceDirectory) -> Result<()> {
        let mut snapshot = self
            .0
            .write()
            .map_err(|_| Error::Storage("发现接受状态异常".into()))?;
        let mut state = attempt
            .state
            .lock()
            .map_err(|_| Error::Storage("发现裁定异常".into()))?;
        let result = attempt
            .check(&state)
            .and_then(|()| current_attempt(&snapshot, attempt))
            .and_then(|()| {
                if !state.started
                    || !snapshot
                        .discovery_started
                        .get(&attempt.provider.id)
                        .is_some_and(|(generation, job)| {
                            generation == &attempt.provider.generation && job == &attempt.job_id
                        })
                {
                    Err(Error::Conflict("发现开始标记已撤销".into()))
                } else {
                    Ok(())
                }
            });
        if let Err(error) = result {
            if matches!(state.decision, Decision::Pending) {
                state.decision = Decision::Cancelled(Rejection::from_error(&error));
            }
            return Err(error);
        }
        state.decision = Decision::Accepted(Box::new(directory.clone()));
        snapshot
            .directories
            .insert(attempt.provider.id.clone(), directory);
        tracing::info!(job_id = %attempt.job_id, "发现目录已接受");
        Ok(())
    }
}

fn current_attempt(snapshot: &crate::registry::Snapshot, attempt: &Attempt) -> Result<()> {
    let current = snapshot
        .owners
        .get(&attempt.provider.id)
        .filter(|owner| Arc::ptr_eq(owner, &attempt.owner))
        .and_then(|owner| super::rules::provider(owner));
    if current.is_none_or(|provider| provider.generation != attempt.provider.generation)
        || !snapshot
            .entries
            .contains_key(&attempt.provider.definition.discover_operation)
    {
        return Err(Error::Conflict("发现提供者或贡献已撤销".into()));
    }
    Ok(())
}
