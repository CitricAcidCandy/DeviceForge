//! 公共服务入口复用 Job；反向子调用在父调度槽内执行，使用独立有界配额。
mod nested;
mod registry;
#[cfg(test)]
mod tests;
use crate::Application;
use apk_domain::{Job, Result, services::*};
pub(crate) use nested::Invocation;
pub(crate) use nested::validate_outputs;
pub(crate) use registry::{catalog, validate};
use std::sync::Arc;

impl Application {
    pub fn services(&self) -> Result<Vec<ServiceInfo>> {
        self.registry.services()
    }

    pub async fn call_service(
        self: &Arc<Self>,
        id: String,
        request: ServiceCallRequest,
    ) -> Result<Job> {
        let reference = ServiceRef {
            id,
            version: request.version,
        };
        let (_, registered) = self
            .registry
            .service(&reference, request.generation.as_deref())?;
        let operation = registered.operation.id.clone();
        let submission = self.prepare_submission(request.input.clone(), registered, None)?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut guard = SubmitCancel(Some(cancel.clone()));
        let result = self
            .dispatch_submission(operation, request.input, submission, Some(cancel))
            .await
            .map(|(job, _)| job);
        guard.0.take();
        result
    }
}

struct SubmitCancel(Option<tokio_util::sync::CancellationToken>);
impl Drop for SubmitCancel {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel.cancel();
        }
    }
}
