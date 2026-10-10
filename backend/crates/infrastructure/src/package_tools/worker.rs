//! 包规则的受限同步工作；实际闭包持有许可和调用者资源至退出。
use crate::{
    execution_deadline,
    package_work::{PackageCapacity, State},
};
use apk_domain::{Error, Result};
use deviceforge_android_package_core::Control;
use deviceforge_observability::LogContext;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Pool {
    slots: Arc<Semaphore>,
    states: Arc<Mutex<Vec<Weak<Mutex<State>>>>>,
    capacity: PackageCapacity,
}

impl Default for Pool {
    fn default() -> Self {
        Self::new(PackageCapacity::default())
    }
}

impl Pool {
    pub(crate) fn new(capacity: PackageCapacity) -> Self {
        Self {
            slots: capacity.slots.clone(),
            states: Arc::default(),
            capacity,
        }
    }
    pub(crate) fn unresolved(&self) -> bool {
        let Ok(mut states) = self.states.lock() else {
            return true;
        };
        states.retain(|state| state.strong_count() != 0);
        states.iter().filter_map(Weak::upgrade).any(|state| {
            state
                .lock()
                .map_or(true, |state| state.detached && !state.finished)
        })
    }

    pub(crate) async fn run<T: Send + 'static>(
        &self,
        cancel: CancellationToken,
        deadline: Option<std::time::Instant>,
        work: impl FnOnce(&Control<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let point = deadline.map(tokio::time::Instant::from_std);
        let permit = execution_deadline::run(&cancel, point, async {
            self.slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Error::Conflict("包工作容量已关闭".into()))
        })
        .await?;
        let state = Arc::new(Mutex::new(State::default()));
        {
            let mut states = self
                .states
                .lock()
                .map_err(|_| Error::Dependency("包工作状态异常".into()))?;
            states.retain(|state| state.strong_count() != 0);
            states.push(Arc::downgrade(&state));
        }
        let context = LogContext::current().unwrap_or_default();
        let span = tracing::Span::current();
        let finished = state.clone();
        let signal_token = cancel.clone();
        let worker = self.capacity.spawn(&state, move || {
            let _finished = Finished(finished);
            let _permit = permit;
            let signal = || signal_token.is_cancelled();
            let control = Control::new(deadline, &signal);
            context.sync_scope(|| {
                span.in_scope(|| {
                    control.check().map_err(super::control_error)?;
                    let value = work(&control)?;
                    control.check().map_err(super::control_error)?;
                    Ok(value)
                })
            })
        })?;
        let mut waiting = Waiting {
            state,
            cancel,
            armed: true,
        };
        let joined = worker.await;
        waiting.armed = false;
        let result = joined.map_err(|_| Error::Dependency("包工作任务异常".into()))?;
        execution_deadline::check(&waiting.cancel, point)?;
        result
    }
}

struct Waiting {
    state: Arc<Mutex<State>>,
    cancel: CancellationToken,
    armed: bool,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.cancel();
            if let Ok(mut state) = self.state.lock() {
                state.detached = true;
            }
        }
    }
}

struct Finished(Arc<Mutex<State>>);
impl Drop for Finished {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.finished = true;
        }
    }
}

#[cfg(test)]
mod tests;
