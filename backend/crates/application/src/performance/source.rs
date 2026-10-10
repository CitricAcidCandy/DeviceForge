//! 当前注册来源的轻量访问；只短暂升级宿主，不形成会话与宿主的强引用环。
use crate::{
    Application,
    registry::{Owner, Registered},
};
use apk_domain::{Error, Result, performance::*};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock, Weak};
use tokio::time::Instant;
use tokio_util::{sync::CancellationToken, task::task_tracker::TaskTrackerToken};

pub(super) struct SourceAccess {
    default_plugin: Option<String>,
    application: OnceLock<Weak<Application>>,
}

#[derive(Clone)]
pub(super) struct SourceBinding {
    pub reference: PerformanceSourceRef,
    pub capabilities: ProbeCapabilities,
    pub owner: Arc<Owner>,
    registered: Arc<Registered>,
    input: Value,
}

impl SourceAccess {
    pub fn new(default_plugin: Option<String>) -> Result<Self> {
        if let Some(id) = &default_plugin {
            apk_domain::plugins::plugin_id(id)?;
        }
        Ok(Self {
            default_plugin,
            application: OnceLock::new(),
        })
    }

    pub fn bind(&self, application: &Arc<Application>) -> Result<()> {
        self.application
            .set(Arc::downgrade(application))
            .map_err(|_| Error::Conflict("性能来源访问已绑定宿主".into()))
    }

    fn application(&self) -> Result<Arc<Application>> {
        self.application
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| Error::Dependency("性能来源宿主不可用".into()))
    }

    fn current(&self) -> Result<(Arc<Application>, Arc<Registered>)> {
        let application = self.application()?;
        let id = self
            .default_plugin
            .as_ref()
            .ok_or_else(|| Error::NotFound("性能采样源不可用".into()))?;
        let registered = {
            let snapshot = application
                .registry
                .0
                .read()
                .map_err(|_| Error::Storage("性能来源注册表读取异常".into()))?;
            let owner = snapshot
                .owners
                .get(id)
                .ok_or_else(|| Error::NotFound("性能采样源不可用".into()))?;
            let definition = owner
                .performance
                .as_ref()
                .ok_or_else(|| Error::NotFound("性能采样源不可用".into()))?;
            if owner.info().cleanup_failed {
                return Err(Error::CleanupFailed);
            }
            if owner.cancel.is_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            snapshot
                .entries
                .get(&definition.operation)
                .filter(|entry| {
                    entry
                        .owner
                        .as_ref()
                        .is_some_and(|entry_owner| Arc::ptr_eq(entry_owner, owner))
                })
                .cloned()
                .ok_or_else(|| Error::NotFound("性能采样源不可用".into()))?
        };
        Ok((application, registered))
    }

    pub fn capabilities(&self) -> Result<ProbeCapabilities> {
        let (application, registered) = self.current()?;
        application.registry.with_current(&registered, || {
            let owner = registered.owner.as_ref().expect("来源必须归属于插件");
            if owner.info().cleanup_failed {
                return Err(Error::CleanupFailed);
            }
            if owner.cancel.is_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            Ok(ProbeCapabilities {
                source: format!("plugin.{}", owner.info().id),
                fps: owner.performance.as_ref().expect("已验证来源").fps,
            })
        })
    }

    /// 启动工作在撤销排序点前登记；随后阻塞落库仍归同一 owner 排空。
    pub fn admit(
        &self,
        target: &PerformanceTarget,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<(SourceBinding, TaskTrackerToken)> {
        target.validate()?;
        crate::operation_budget::check(deadline, Some(cancel))?;
        let (application, registered) = self.current()?;
        let owner = registered.owner.clone().expect("来源必须归属于插件");
        let info = owner.info();
        let definition = owner.performance.as_ref().expect("已验证来源");
        let input = if definition.device_capability.is_some() {
            json!({"device_id":target.device_id,"input":{"package":target.package}})
        } else {
            json!({"device_id":target.device_id,"package":target.package})
        };
        if !registered.validator.is_valid(&input) {
            return Err(Error::Invalid("目标不符合插件性能输入模式".into()));
        }
        let device = if definition.device_capability.is_some() {
            let (provider_id, local_id, _) = application
                .registry
                .device_admission(&registered, &input)?
                .ok_or_else(|| Error::Invalid("性能来源缺少设备能力准入".into()))?;
            Some(apk_domain::devices::DeviceRef {
                provider_id,
                generation: info.generation.clone(),
                local_id: local_id.expect("性能采样要求设备范围"),
            })
        } else {
            None
        };
        let binding = SourceBinding {
            reference: PerformanceSourceRef {
                plugin_id: info.id.clone(),
                generation: info.generation,
                operation: definition.operation.clone(),
                device,
            },
            capabilities: ProbeCapabilities {
                source: format!("plugin.{}", info.id),
                fps: definition.fps,
            },
            owner,
            registered,
            input,
        };
        let token = binding.claim(self, cancel, deadline)?;
        Ok((binding, token))
    }
}

impl SourceBinding {
    pub fn check_current(&self, access: &SourceAccess) -> Result<()> {
        let application = access.application()?;
        application.registry.with_current(&self.registered, || {
            if self.owner.info().cleanup_failed {
                return Err(Error::CleanupFailed);
            }
            if self.owner.cancel.is_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            Ok(())
        })?;
        if self.reference.device.is_some() {
            application
                .registry
                .device_admission(&self.registered, &self.input)?;
        }
        Ok(())
    }

    /// 只作内存资格登记，调用者不得在该锁内执行 I/O。
    pub fn claim(
        &self,
        access: &SourceAccess,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<TaskTrackerToken> {
        let application = access.application()?;
        application.registry.with_current(&self.registered, || {
            crate::operation_budget::check(deadline, Some(cancel))?;
            if self.owner.info().cleanup_failed {
                return Err(Error::CleanupFailed);
            }
            if self.owner.cancel.is_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            Ok(self.owner.tracker.token())
        })
    }

    /// 暂停和停止可收口已有清理风险，仍须在当前代际内取得资格。
    pub fn control_claim(
        &self,
        access: &SourceAccess,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<TaskTrackerToken> {
        let application = access.application()?;
        application.registry.with_current(&self.registered, || {
            crate::operation_budget::check(deadline, Some(cancel))?;
            if self.owner.cancel.is_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            Ok(self.owner.tracker.token())
        })
    }

    pub fn deadline(&self, admitted: Instant, inherited: Instant) -> Instant {
        let capability = self.owner.provider.as_ref().and_then(|provider| {
            provider
                .capabilities
                .iter()
                .find(|cap| cap.operation == self.reference.operation)
        });
        let special = crate::devices::rules::execution_deadline(
            &self.registered,
            capability,
            admitted,
            Some(inherited),
        );
        crate::operation_budget::deadline(&self.registered, admitted, special, Some(inherited))
            .expect("采样始终具有固定预算")
    }
}

mod sampling;

#[cfg(test)]
mod tests;
