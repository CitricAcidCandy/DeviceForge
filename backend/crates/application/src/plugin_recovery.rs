//! 通用后台恢复的有界监督；不冻结普通调用，不改历史会话终态。
use crate::{Application, registry::Owner};
use apk_domain::{Error, ExecutionContext, Result, plugin_recovery::*};
use deviceforge_observability::LogContext;
use futures_util::FutureExt;
use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

struct Reservation(Arc<Owner>);
impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.recovering.store(false, Ordering::Release);
    }
}

fn view(owner: &Owner) -> RecoveryView {
    let info = owner.info();
    RecoveryView {
        id: info.id,
        generation: info.generation,
        supported: owner.executor.recovery_timeout().is_some(),
        cleanup_failed: info.cleanup_failed,
        recovering: owner.recovering.load(Ordering::Acquire),
        last_report: owner
            .recovery_report
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone(),
    }
}

async fn perform(
    owner: &Owner,
    input: serde_json::Value,
    token: &tokio_util::sync::CancellationToken,
    deadline: tokio::time::Instant,
) -> RecoveryReport {
    let work = AssertUnwindSafe(owner.executor.recover_resources(
        input,
        token.clone(),
        ExecutionContext {
            deadline: Some(deadline.into_std()),
        },
    ))
    .catch_unwind();
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => match result {
            Ok(Ok(report)) if report.validate() => report,
            _ => RecoveryReport::blocked("后台回收未完成，已保留诊断；不影响新调用"),
        },
        _ = owner.cancel.cancelled() => {
            token.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut work).await;
            RecoveryReport::blocked("插件正在退出，旧资源回收尚未确认")
        },
        _ = token.cancelled() => {
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut work).await;
            RecoveryReport::blocked("服务停止，资源核对未确认")
        },
        _ = tokio::time::sleep_until(deadline) => {
            token.cancel();
            // 只给传输监督收口，不再接受迟到成功；返回前先析构真实工作Future。
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut work).await;
            RecoveryReport::blocked("资源核对超时，请检查设备连接后重试")
        }
    }
}

impl Application {
    pub fn plugin_recovery_view(&self, id: &str) -> Result<RecoveryView> {
        apk_domain::plugins::plugin_id(id)?;
        let registry = self
            .registry
            .0
            .read()
            .map_err(|_| Error::Storage("恢复目录读取异常".into()))?;
        let owner = registry
            .owners
            .get(id)
            .ok_or_else(|| Error::NotFound("插件未加载".into()))?;
        Ok(view(owner))
    }

    pub async fn recover_plugin(
        self: &Arc<Self>,
        id: String,
        mut request: RecoveryInput,
    ) -> Result<RecoveryView> {
        apk_domain::plugins::plugin_id(&id)?;
        if !request.input.is_object()
            || request.generation.is_empty()
            || request.generation.len() > 100
        {
            return Err(Error::Invalid("恢复须包含有效代际和对象输入".into()));
        }
        if serde_json::to_vec(&request.input)
            .map_err(|_| Error::Invalid("恢复输入无效".into()))?
            .len()
            > 8192
        {
            return Err(Error::TooLarge);
        }
        let task = {
            // 只与宿主停止、插件换代串行登记；回收旧资源不要求新调用排空。
            let active = self
                .active
                .lock()
                .map_err(|_| Error::Storage("恢复准入异常".into()))?;
            if !active.accepting {
                return Err(Error::Conflict("服务正在停止".into()));
            }
            let registry = self
                .registry
                .0
                .read()
                .map_err(|_| Error::Storage("恢复目录读取异常".into()))?;
            let owner = registry
                .owners
                .get(&id)
                .cloned()
                .ok_or_else(|| Error::NotFound("插件未加载".into()))?;
            if owner.info().generation != request.generation {
                return Err(Error::Conflict("插件代际已变化，请重新获取恢复状态".into()));
            }
            if owner.cancel.is_cancelled() {
                return Err(Error::Conflict("插件正在退出".into()));
            }
            let timeout = owner
                .executor
                .recovery_timeout()
                .ok_or_else(|| Error::Conflict("当前插件未提供资源核对与恢复能力".into()))?;
            if !(Duration::from_secs(1)..=Duration::from_secs(30)).contains(&timeout) {
                return Err(Error::Invalid("插件恢复预算无效".into()));
            }
            let recovery_gate = owner
                .recovery_admission
                .lock()
                .map_err(|_| Error::Storage("插件资源准入异常".into()))?;
            if owner.recovering.load(Ordering::Acquire) {
                let mut result = view(&owner);
                result.last_report =
                    Some(RecoveryReport::busy("旧资源已在后台回收，新调用可以继续"));
                return Ok(result);
            }
            let permit = self
                .recovery_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::Conflict("资源核对工作已达到并发上限".into()))?;
            owner.recovering.store(true, Ordering::Release);
            let owner_token = owner.tracker.token();
            drop(recovery_gate);
            let reservation = Reservation(owner.clone());
            let token = self.recovery_cancel.child_token();
            let deadline = tokio::time::Instant::now() + timeout;
            let risk_revision = owner.risk_revision.load(Ordering::Acquire);
            // 保留字段由宿主覆盖，客户端不能把旧资源缺失登记伪装成无风险空台账。
            request
                .input
                .as_object_mut()
                .expect("已验证恢复对象")
                .insert(
                    "_host_cleanup_unconfirmed".into(),
                    owner.info().cleanup_failed.into(),
                );
            self.tracker.spawn(LogContext::propagate(async move {
                let _permit = permit;
                let _owner_token = owner_token;
                let reservation = reservation;
                tracing::info!(plugin_id = %id, "插件资源核对开始");
                let mut report = perform(&owner, request.input, &token, deadline).await;
                let confirmed = report.status == RecoveryStatus::Recovered && !token.is_cancelled()
                    && !owner.cancel.is_cancelled()
                    && risk_revision == owner.risk_revision.load(Ordering::Acquire)
                    && tokio::time::Instant::now() < deadline
                    && !owner.executor.has_unresolved_resources()
                    && !owner.session_provider.as_ref().is_some_and(|provider| provider.has_unresolved_resources())
                    && owner.confirm_recovery(risk_revision);
                if !confirmed && report.status != RecoveryStatus::Busy {
                    owner.mark_unresolved();
                    if report.status == RecoveryStatus::Recovered {
                        report = RecoveryReport::blocked("仍有旧资源待后台回收，不影响新调用");
                    }
                }
                *owner.recovery_report.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(report);
                drop(reservation);
                let result = view(&owner);
                tracing::info!(plugin_id = %id, cleanup_failed = result.cleanup_failed, "插件资源核对结束");
                Ok(result)
            }))
        };
        task.await
            .map_err(|_| Error::Dependency("资源核对监督异常".into()))?
    }

    /// 历史清理告警不再让新会话等待恢复；显式核对仍由独立恢复入口负责。
    pub async fn open_session_recovering_with_client(
        self: &Arc<Self>,
        operation: &str,
        input: serde_json::Value,
        client_is_local: Option<bool>,
    ) -> Result<apk_domain::interactive::SessionInfo> {
        let registered = self.registry.session(operation)?;
        registered
            .validator
            .validate(&input)
            .map_err(|_| Error::Invalid("会话打开参数不符合模式".into()))?;
        if !self.registry.current_session(&registered)? {
            return Err(Error::Conflict("核对期间插件代际已变化，请重新打开".into()));
        }
        self.open_session_with_client(operation, input, client_is_local)
    }
}

mod background;
#[cfg(test)]
mod tests;
