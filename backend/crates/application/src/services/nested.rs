//! 子调用继承父截止点和取消树；拒绝递归、容量及父已持锁冲突，不等待父工作槽。
use crate::{Application, registry::Registered};
use apk_domain::{Error, ExecutionContext, Result, services::*};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{Arc, Weak};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct LockClaim {
    provider: String,
    device: Option<String>,
    provider_write: bool,
}

impl LockClaim {
    fn conflicts(&self, other: &Self) -> bool {
        self.provider == other.provider
            && (self.provider_write
                || other.provider_write
                || self
                    .device
                    .as_ref()
                    .is_some_and(|device| other.device.as_ref() == Some(device)))
    }
}

pub(crate) struct Invocation {
    app: Weak<Application>,
    source: Arc<Registered>,
    path: Vec<String>,
    held: Vec<LockClaim>,
    slots: Arc<Semaphore>,
    deadline: tokio::time::Instant,
    cancel: CancellationToken,
}

fn claim(app: &Application, source: &Arc<Registered>, input: &Value) -> Result<Option<LockClaim>> {
    Ok(app
        .registry
        .device_admission(source, input)?
        .map(|(provider, device, capability)| LockClaim {
            provider,
            device: if capability.scope == apk_domain::devices::CapabilityScope::Device
                && capability.access == apk_domain::devices::CapabilityAccess::Write
            {
                device
            } else {
                None
            },
            provider_write: capability.scope == apk_domain::devices::CapabilityScope::Provider
                && capability.access == apk_domain::devices::CapabilityAccess::Write,
        }))
}

impl Invocation {
    pub(crate) fn root(
        app: &Arc<Application>,
        source: Arc<Registered>,
        input: &Value,
        deadline: Option<tokio::time::Instant>,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>> {
        let held = claim(app, &source, input)?.into_iter().collect();
        Ok(Arc::new(Self {
            app: Arc::downgrade(app),
            path: vec![source.operation.id.clone()],
            source,
            held,
            slots: Arc::new(Semaphore::new(4)),
            deadline: deadline.unwrap_or_else(|| {
                tokio::time::Instant::now() + std::time::Duration::from_secs(120)
            }),
            cancel,
        }))
    }
}

#[async_trait]
impl ServiceCaller for Invocation {
    async fn call(
        &self,
        reference: ServiceRef,
        input: Value,
        requested_cancel: CancellationToken,
    ) -> Result<Value> {
        let app = self.app.upgrade().ok_or(Error::Cancelled)?;
        crate::operation_budget::check(Some(self.deadline), Some(&self.cancel))?;
        if requested_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if !app
            .registry
            .current(&self.source.operation.id, &self.source)?
        {
            return Err(Error::Conflict("父调用代际已撤销".into()));
        }
        let (provided, target) = app.registry.service(&reference, None)?;
        if self.path.len() > 8 || self.path.contains(&target.operation.id) {
            return Err(Error::Conflict("服务递归或子调用深度超过 8".into()));
        }
        let _slot =
            self.slots.clone().try_acquire_owned().map_err(|_| {
                Error::Conflict("每根任务最多 4 个活动子调用，拒绝等待祖先名额".into())
            })?;
        let submission =
            app.prepare_submission(input.clone(), target.clone(), Some(self.deadline))?;
        let deadline = submission.deadline().unwrap_or(self.deadline);
        let lock = claim(&app, &target, &input)?;
        if lock
            .as_ref()
            .is_some_and(|lock| self.held.iter().any(|held| held.conflicts(lock)))
        {
            return Err(Error::Conflict("子调用请求父调用已持有的互斥资源".into()));
        }
        let selection = app
            .registry
            .device_admission(&target, &input)?
            .map(|(provider, device, cap)| {
                app.device_locks
                    .selection(&provider, device.as_deref(), &cap.scope, &cap.access)
            })
            .transpose()?;
        let ancestor_read = lock.as_ref().is_some_and(|lock| {
            self.held
                .iter()
                .any(|ancestor| ancestor.provider == lock.provider)
        });
        let cancel = self.cancel.child_token();
        let mut held = self.held.clone();
        held.extend(lock);
        let mut path = self.path.clone();
        path.push(target.operation.id.clone());
        let child = Arc::new(Self {
            app: self.app.clone(),
            source: target.clone(),
            path,
            held,
            slots: self.slots.clone(),
            deadline,
            cancel: cancel.clone(),
        });
        let owner = target.owner.as_ref();
        let _owner_claim = owner.map(|owner| owner.claim()).transpose()?;
        let future = async {
            let _guard = match selection {
                Some(selection) => Some(
                    selection
                        .acquire_descendant_until(&cancel, deadline, ancestor_read)
                        .await?,
                ),
                None => None,
            };
            if !app.registry.current(&target.operation.id, &target)?
                || owner.is_some_and(|owner| owner.cancel.is_cancelled())
            {
                return Err(Error::Conflict("子调用启动前目标代际已撤销".into()));
            }
            app.registry
                .check_required(target.executor.as_ref(), &target.operation.id, false)?;
            let result = target
                .executor
                .execute_with_services(
                    &target.operation.id,
                    input,
                    cancel.clone(),
                    ExecutionContext {
                        deadline: Some(deadline.into_std()),
                    },
                    Arc::new(apk_domain::NoProgress),
                    child,
                )
                .await?;
            crate::operation_budget::check(Some(deadline), Some(&cancel))?;
            app.registry.with_current(&target, || {
                validate_output(&target, &provided.service, &result)?;
                if target.executor.result_format()
                    == apk_domain::ExecutorResultFormat::PublishedArtifacts
                {
                    Ok(result.get("result").expect("已验证结果封套").clone())
                } else {
                    Ok(result)
                }
            })
        };
        let execution =
            crate::execution::settle(future, &cancel, owner.map(AsRef::as_ref), Some(deadline));
        tokio::pin!(execution);
        let result = tokio::select! { biased;
            _ = requested_cancel.cancelled() => { cancel.cancel(); execution.await },
            _ = async { match owner { Some(owner) => owner.cancel.cancelled().await, None => std::future::pending().await } } => { cancel.cancel(); execution.await },
            result = &mut execution => result,
        };
        tracing::info!(service_id = %reference.id, service_version = %reference.version, depth = self.path.len(), code = result.as_ref().err().map(Error::code).unwrap_or("ok"), "服务子调用结束");
        result
    }
}

pub(crate) fn validate_output(
    target: &Registered,
    reference: &ServiceRef,
    result: &Value,
) -> Result<()> {
    let value = if target.executor.result_format()
        == apk_domain::ExecutorResultFormat::PublishedArtifacts
    {
        result
            .get("result")
            .ok_or_else(|| Error::Dependency("服务产物结果封套缺失".into()))?
    } else {
        result
    };
    let validator = target
        .service_outputs
        .get(reference)
        .ok_or_else(|| Error::Invalid("服务输出契约尚未注册".into()))?;
    validator
        .validate(value)
        .map_err(|_| Error::Dependency("服务输出不符合契约".into()))
}

pub(crate) fn validate_outputs(target: &Registered, result: &Value) -> Result<()> {
    for reference in target.service_outputs.keys() {
        validate_output(target, reference, result)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lock(provider: &str, device: Option<&str>, provider_write: bool) -> LockClaim {
        LockClaim {
            provider: provider.into(),
            device: device.map(Into::into),
            provider_write,
        }
    }
    #[test]
    fn only_real_ancestor_exclusive_locks_conflict() {
        assert!(lock("a", Some("x"), false).conflicts(&lock("a", Some("x"), false)));
        assert!(!lock("a", Some("x"), false).conflicts(&lock("a", Some("y"), false)));
        assert!(!lock("a", Some("x"), false).conflicts(&lock("b", Some("x"), false)));
        assert!(!lock("a", None, false).conflicts(&lock("a", Some("x"), false)));
        assert!(lock("a", None, true).conflicts(&lock("a", None, false)));
    }
}
