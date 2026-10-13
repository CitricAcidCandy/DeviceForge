use super::state::Resources;
use deviceforge_plugin_runtime::InvocationContext;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time};

static WORKERS: Semaphore = Semaphore::const_new(1);

struct Guard {
    resources: Arc<Resources>,
    confirmed: bool,
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.resources.fail_cleanup();
        }
    }
}

#[cfg(test)]
mod tests;

pub(crate) async fn run<Value, Action>(
    context: &InvocationContext,
    resources: &Arc<Resources>,
    action: Action,
) -> Result<Value, String>
where
    Value: Send + 'static,
    Action: FnOnce(Arc<Resources>, InvocationContext) -> Result<Value, String> + Send + 'static,
{
    context.check().map_err(|error| error.to_string())?;
    let cancel = context.cancellation();
    let permit = tokio::select! {
        biased;
        _ = time::sleep_until(context.deadline().into()) => return Err("AI文件工作超过原期限".into()),
        _ = cancel.cancelled() => return Err("AI文件工作已取消".into()),
        permit = WORKERS.acquire() => permit.map_err(|_| "AI文件工作池已关闭")?,
    };
    let mut guard = Guard {
        resources: resources.clone(),
        confirmed: false,
    };
    let owned_resources = resources.clone();
    let owned_context = context.clone();
    let mut handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        action(owned_resources, owned_context)
    });
    let interrupted = tokio::select! {
        biased;
        _ = time::sleep_until(context.deadline().into()) => "AI文件工作超过原期限",
        _ = cancel.cancelled() => "AI文件工作已取消",
        result = &mut handle => {
            guard.confirmed = result.is_ok();
            return result.map_err(|_| "AI文件工作异常，清理未确认".to_owned())?;
        }
    };
    let cleanup_deadline = time::Instant::now() + Duration::from_secs(2);
    if let Ok(Ok(_)) = time::timeout_at(cleanup_deadline, &mut handle).await {
        guard.confirmed = true;
        Err(interrupted.into())
    } else {
        Err("AI文件工作未在固定清理点返回".into())
    }
}
