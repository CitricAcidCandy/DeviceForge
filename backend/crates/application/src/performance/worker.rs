//! 有界后台采样与会话提交序列；采样不占普通 Job 工作线程，也不创建嵌套 Job。
use super::*;
use deviceforge_observability::LogContext;
use futures_util::FutureExt;
use std::{future::pending, panic::AssertUnwindSafe, time::Duration};
use tokio::{sync::OwnedSemaphorePermit, time::MissedTickBehavior};
use tokio_util::task::task_tracker::TaskTrackerToken;
use tracing::Instrument;

struct SampleFlight {
    runtime: Arc<Runtime>,
    _owner: Option<TaskTrackerToken>,
    executing: bool,
}
impl SampleFlight {
    fn begin(
        runtime: Arc<Runtime>,
        cancel: CancellationToken,
        owner: Option<TaskTrackerToken>,
    ) -> Self {
        runtime.sample_in_flight.store(true, Ordering::Release);
        *runtime
            .sample_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(cancel);
        Self {
            runtime,
            _owner: owner,
            executing: false,
        }
    }
}
impl Drop for SampleFlight {
    fn drop(&mut self) {
        if self.executing {
            self.runtime.mark_unresolved();
        }
        *self
            .runtime
            .sample_cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.runtime
            .sample_in_flight
            .store(false, Ordering::Release);
    }
}

async fn owner_revoked(runtime: &Runtime) {
    if let Some(binding) = &runtime.binding {
        binding.owner.cancel.cancelled().await;
    } else {
        pending::<()>().await;
    }
}

impl PerformanceService {
    pub(super) fn spawn_worker(
        &self,
        session: PerformanceSession,
        runtime: Arc<Runtime>,
        receiver: watch::Receiver<u64>,
        permit: OwnedSemaphorePermit,
        owner: Option<TaskTrackerToken>,
    ) -> JoinHandle<Result<()>> {
        let service = self.clone();
        let tracked = self.0.tracker.token();
        let reference = session.source.as_ref();
        let span = tracing::info_span!("性能会话", session_id = %session.id,
            source_plugin_id = %reference.map(|source| source.plugin_id.as_str()).unwrap_or(""),
            source_generation = %reference.map(|source| source.generation.as_str()).unwrap_or(""));
        tokio::spawn(LogContext::propagate(
            async move {
                let (_permit, _tracked, _owner) = (permit, tracked, owner);
                tracing::info!("性能会话已创建");
                let outcome = AssertUnwindSafe(service.run(&session, runtime.clone(), receiver))
                    .catch_unwind()
                    .await;
                let outcome = match outcome {
                    Ok(Ok(())) => Ok(()),
                    outcome => {
                        let failure = match outcome {
                            Ok(Err(error)) => error,
                            _ => {
                                runtime.mark_unresolved();
                                Error::Dependency("性能采样执行器异常".into())
                            }
                        };
                        // run 中的终态落库已经失败时，不在同一轮重开终态写入。
                        if service
                            .0
                            .controls
                            .lock()
                            .await
                            .active
                            .get(&session.id)
                            .is_some_and(|active| active.pending_terminal.is_some())
                        {
                            Err(failure)
                        } else {
                            let state = if Instant::now() >= runtime.deadline {
                                PerformanceState::Completed
                            } else if runtime.source_cancelled() || runtime.cancel.is_cancelled() {
                                PerformanceState::Interrupted
                            } else {
                                PerformanceState::Failed
                            };
                            let error = if state == PerformanceState::Completed {
                                None
                            } else {
                                Some(failure.to_string())
                            };
                            service.finish(&session.id, &runtime, state, error).await
                        }
                    }
                };
                if outcome.is_ok() {
                    service.0.controls.lock().await.active.remove(&session.id);
                    tracing::info!("性能会话已收敛");
                }
                outcome
            }
            .instrument(span),
        ))
    }

    async fn run(
        &self,
        session: &PerformanceSession,
        runtime: Arc<Runtime>,
        mut wake: watch::Receiver<u64>,
    ) -> Result<()> {
        let mut interval = tokio::time::interval(Duration::from_millis(u64::from(
            session.request.interval_ms,
        )));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            if Instant::now() >= runtime.deadline {
                return self
                    .finish(&session.id, &runtime, PerformanceState::Completed, None)
                    .await;
            }
            if runtime.cancel.is_cancelled() || runtime.source_cancelled() {
                return self
                    .finish(
                        &session.id,
                        &runtime,
                        PerformanceState::Interrupted,
                        Some("性能采样器已停止".into()),
                    )
                    .await;
            }
            let id = session.id.clone();
            let context = CallContext::new(runtime.cancel.clone(), Some(runtime.deadline));
            let current = self
                .database(runtime.owner(), &context, move |store| store.get(&id))
                .await?;
            if current.state.terminal() {
                return Ok(());
            }
            if current.state == PerformanceState::Paused {
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(runtime.deadline) => {},
                    _ = runtime.cancel.cancelled() => {},
                    _ = owner_revoked(&runtime) => {},
                    changed = wake.changed() => {
                        if changed.is_err() { return Err(Error::Cancelled); }
                        interval.reset_immediately();
                    },
                }
                continue;
            }
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(runtime.deadline) => continue,
                _ = runtime.cancel.cancelled() => continue,
                _ = owner_revoked(&runtime) => continue,
                changed = wake.changed() => {
                    if changed.is_err() { return Err(Error::Cancelled); }
                    interval.reset_immediately(); continue;
                },
                _ = interval.tick() => {},
            }
            self.tick(session, runtime.clone()).await?;
        }
    }

    async fn tick(&self, session: &PerformanceSession, runtime: Arc<Runtime>) -> Result<()> {
        let admitted = Instant::now();
        let deadline = runtime
            .binding
            .as_ref()
            .map(|binding| binding.deadline(admitted, runtime.deadline))
            .unwrap_or_else(|| (admitted + Duration::from_secs(10)).min(runtime.deadline));
        let cancel = runtime.cancel.child_token();
        let context = CallContext::new(cancel.clone(), Some(deadline));
        let sequence = context.wait(runtime.sequence.clone().lock_owned()).await?;
        let id = session.id.clone();
        let current = self
            .database(runtime.owner(), &context, move |store| store.get(&id))
            .await?;
        if current.state != PerformanceState::Running || runtime.source_cancelled() {
            return Ok(());
        }
        let token = match (&self.0.source, &runtime.binding) {
            (Source::Registered(access), Some(binding)) => {
                binding.check_current(access)?;
                Some(binding.claim(access, &cancel, Some(deadline))?)
            }
            _ => None,
        };
        // 在提交序列内发布样本取消树，暂停持久化之后不会遗漏该样本。
        let mut flight = SampleFlight::begin(runtime.clone(), cancel, token);
        drop(sequence);
        let span = tracing::info_span!("性能采样", session_id = %session.id, sample_revision = current.revision,
            source_plugin_id = %runtime.binding.as_ref().map(|binding| binding.reference.plugin_id.as_str()).unwrap_or(""),
            source_generation = %runtime.binding.as_ref().map(|binding| binding.reference.generation.as_str()).unwrap_or(""));
        let result = self
            .execute_sample(&session.request.target, &runtime, &context, &mut flight)
            .instrument(span)
            .await;
        let outcome = match result {
            Ok(sample) => {
                self.append_sample(
                    &session.id,
                    current.revision,
                    runtime.clone(),
                    &context,
                    sample,
                    flight,
                )
                .await
            }
            Err(error) => {
                drop(flight);
                Err(error)
            }
        };
        if let Err(error) = outcome {
            if runtime.source_cancelled()
                || runtime.cancel.is_cancelled()
                || Instant::now() >= runtime.deadline
            {
                return Ok(());
            }
            self.fail_sample(&session.id, current.revision, &runtime, error)
                .await?;
        }
        Ok(())
    }

    async fn execute_sample(
        &self,
        target: &PerformanceTarget,
        runtime: &Arc<Runtime>,
        context: &CallContext,
        flight: &mut SampleFlight,
    ) -> Result<(RawPerformance, OwnedSemaphorePermit)> {
        let permit = context
            .wait(self.0.sample_workers.clone().acquire_owned())
            .await?
            .map_err(|_| Error::Conflict("性能采样工作池已关闭".into()))?;
        context.check()?;
        flight.executing = true;
        let result = match (&self.0.source, &runtime.binding) {
            (Source::Registered(access), Some(binding)) => {
                binding
                    .sample(
                        access,
                        context.cancel.clone(),
                        context.deadline.expect("样本必须固定截止点"),
                    )
                    .await
            }
            (Source::Probe(probe), None) => {
                let sample =
                    AssertUnwindSafe(probe.sample(target, context.cancel.clone())).catch_unwind();
                let sample = async {
                    sample
                        .await
                        .unwrap_or_else(|_| Err(Error::Dependency("性能采样执行器异常".into())))
                };
                crate::execution::settle(sample, &context.cancel, None, context.deadline).await
            }
            _ => Err(Error::Dependency("性能会话来源装配不一致".into())),
        };
        flight.executing = false;
        if matches!(result, Err(Error::CleanupFailed)) {
            runtime.mark_unresolved();
        }
        let raw = result?;
        context.check()?;
        raw.validate()?;
        if raw.metric_missing.is_some()
            && match (&self.0.source, &runtime.binding) {
                (Source::Registered(_), Some(binding)) => !binding.capabilities.partial_metrics,
                (Source::Probe(probe), None) => !probe.capabilities().partial_metrics,
                _ => true,
            }
        {
            return Err(Error::Dependency("性能来源未声明部分缺测能力".into()));
        }
        Ok((raw, permit))
    }

    async fn append_sample(
        &self,
        id: &str,
        revision: u64,
        runtime: Arc<Runtime>,
        context: &CallContext,
        sample: (RawPerformance, OwnedSemaphorePermit),
        flight: SampleFlight,
    ) -> Result<()> {
        let (raw, permit) = sample;
        let sequence = context.wait(runtime.sequence.clone().lock_owned()).await?;
        context.check()?;
        let qualified = match (&self.0.source, &runtime.binding) {
            (Source::Registered(access), Some(binding)) => {
                binding.check_current(access)?;
                Some(binding.claim(access, &context.cancel, context.deadline)?)
            }
            _ => None,
        };
        let id = id.to_owned();
        let commit_context = context.clone();
        self.database(runtime.owner(), context, move |store| {
            // 序列、采样槽和来源资格随真实闭包存活，丢弃外层 await 不释放容量。
            let (_sequence, _permit, _flight, _qualified) = (sequence, permit, flight, qualified);
            let current = store.get(&id)?;
            if current.state != PerformanceState::Running || current.revision != revision {
                return Ok(());
            }
            commit_context.check()?;
            store.append(&id, revision, raw)?;
            Ok(())
        })
        .await
    }

    async fn fail_sample(
        &self,
        id: &str,
        revision: u64,
        runtime: &Arc<Runtime>,
        error: Error,
    ) -> Result<()> {
        let sequence = runtime.sequence.clone().lock_owned().await;
        let id = id.to_owned();
        let notify = runtime.clone();
        self.database(runtime.owner(), &CallContext::unbounded(), move |store| {
            let _sequence = sequence;
            let current = store.get(&id)?;
            // 暂停/停止等已提交控制保留；取消清理后的晚结果也不会覆盖它们。
            if current.state != PerformanceState::Running || current.revision != revision {
                return Ok(());
            }
            let updated = store.transition(
                &id,
                revision,
                PerformanceState::Failed,
                Some(error.to_string()),
            )?;
            notify.wake.send_replace(updated.revision);
            Ok(())
        })
        .await
    }
}
