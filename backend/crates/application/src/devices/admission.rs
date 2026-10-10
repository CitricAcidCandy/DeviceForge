//! 在存储工作池之前冻结发现准入及期限，许可随实际工作收敛。
use super::{attempt::Attempt, rules};
use crate::{Application, alias_plan::Plan};
use apk_domain::{Error, Result, devices::DeviceProviderInfo};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedSemaphorePermit};
use tokio_util::sync::CancellationToken;

pub(crate) struct Admission {
    provider: DeviceProviderInfo,
    serial: Arc<Mutex<()>>,
    permit: OwnedSemaphorePermit,
    deadline: tokio::time::Instant,
}
impl Admission {
    pub fn prepare(
        app: &Application,
        plan: &Plan,
        admitted_at: tokio::time::Instant,
        inherited: Option<tokio::time::Instant>,
    ) -> Result<Option<Self>> {
        let Some(owner) = &plan.target.owner else {
            return Ok(None);
        };
        let Some(provider) = rules::provider(owner)
            .filter(|provider| provider.definition.discover_operation == plan.target.operation.id)
        else {
            return Ok(None);
        };
        if !plan
            .input
            .as_object()
            .is_some_and(|fields| fields.is_empty())
        {
            return Err(Error::Invalid("设备发现只接受空对象".into()));
        }
        let deadline = rules::execution_deadline(&plan.target, None, admitted_at, inherited)
            .expect("发现具有固定预算");
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let permit = app
            .device_refreshes
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("设备发现已达到两项在途上限".into()))?;
        let serial = app.device_locks.refresh(&provider.id)?;
        Ok(Some(Self {
            provider,
            serial,
            permit,
            deadline,
        }))
    }
    pub fn attempt(
        self,
        job_id: String,
        plan: &Plan,
        parent: Option<CancellationToken>,
    ) -> Arc<Attempt> {
        Attempt::new(
            job_id,
            self.provider,
            plan.target.owner.clone().expect("发现必须有owner"),
            parent,
            self.deadline,
            self.serial,
            self.permit,
        )
    }
}
