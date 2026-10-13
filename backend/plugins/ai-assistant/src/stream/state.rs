use super::worker;
use crate::sessions::Lease;
use deviceforge_plugin_runtime::InvocationContext;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub(crate) struct Resources {
    lease: Mutex<Option<Lease>>,
    failed: AtomicBool,
}

impl Resources {
    pub(crate) fn fail_cleanup(&self) {
        self.failed.store(true, Ordering::Release);
    }

    pub(crate) fn cleanup_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
}

pub(crate) async fn acquire(
    resources: &Arc<Resources>,
    root: PathBuf,
    id: String,
    project_id: String,
    project: PathBuf,
    resumed: bool,
    context: &InvocationContext,
) -> Result<(), String> {
    worker::run(context, resources, move |resources, context| {
        let check = || context.check().map_err(|error| error.to_string());
        let mut lease = Lease::acquire(&root, &id, &project_id, &project, &check)?;
        if resumed {
            lease.begin(&check)?;
        } else {
            lease.register_uncertain(project_id, project, id, &check)?;
        }
        let mut held = resources.lease.lock().map_err(|_| "AI线程租约异常")?;
        if held.is_some() {
            return Err("AI线程租约不能重复设置".into());
        }
        *held = Some(lease);
        Ok(())
    })
    .await
}

pub(crate) async fn complete(
    resources: &Arc<Resources>,
    project_id: String,
    project: PathBuf,
    id: String,
    context: &InvocationContext,
) -> Result<String, String> {
    worker::run(context, resources, move |resources, context| {
        let mut held = resources.lease.lock().map_err(|_| "AI线程租约异常")?;
        let lease = held.as_mut().ok_or("AI实时线程未登记")?;
        lease.complete(project_id, project, id, &|| {
            context.check().map_err(|error| error.to_string())
        })?;
        Ok(lease
            .snapshot
            .as_ref()
            .ok_or("AI线程未持久化")?
            .turns
            .to_string())
    })
    .await
}
