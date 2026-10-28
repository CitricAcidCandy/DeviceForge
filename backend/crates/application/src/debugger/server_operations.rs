//! 调试操作只捕获原注册贡献，继续使用原输入校验、设备准入与任务调度。
use super::DebugTarget;
use crate::Application;
use apk_domain::{Error, Job, Operation, Result};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

impl Application {
    pub fn debug_operations(&self, target: &DebugTarget) -> Result<Vec<Operation>> {
        if target.target_kind != super::TargetKind::Server {
            return Err(Error::Invalid("服务器操作目录需要服务器目标".into()));
        }
        let snapshot = self
            .registry
            .0
            .read()
            .map_err(|_| Error::Conflict("插件注册状态不可用".into()))?;
        Ok(snapshot
            .entries
            .values()
            .filter(|registered| {
                registered.owner.as_ref().is_some_and(|owner| {
                    let info = owner.info();
                    info.id == target.plugin_id
                        && Some(info.generation.as_str()) == target.generation.as_deref()
                })
            })
            .map(|registered| registered.operation.clone())
            .collect())
    }

    pub async fn debug_submit_operation(
        self: &Arc<Self>,
        target: &DebugTarget,
        id: String,
        input: Value,
    ) -> Result<Job> {
        if target.target_kind != super::TargetKind::Server {
            return Err(Error::Invalid("服务器操作调用需要服务器目标".into()));
        }
        let registered = self.registry.find(&id)?;
        if !registered.owner.as_ref().is_some_and(|owner| {
            let info = owner.info();
            info.id == target.plugin_id
                && Some(info.generation.as_str()) == target.generation.as_deref()
        }) {
            return Err(Error::Conflict("操作不属于所选插件当前代次".into()));
        }
        // 保留捕获的贡献；原调度会再次核对其仍是当前代次，避免检查后重新查找新代。
        let submission = self.prepare_submission(input.clone(), registered, None)?;
        let cancel = CancellationToken::new();
        let mut guard = SubmissionGuard(Some(cancel.clone()));
        let result = self
            .dispatch_submission(id, input, submission, Some(cancel))
            .await
            .map(|(job, _)| job);
        guard.0.take();
        result
    }
}

struct SubmissionGuard(Option<CancellationToken>);
impl Drop for SubmissionGuard {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel.cancel();
        }
    }
}
