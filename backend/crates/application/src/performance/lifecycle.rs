//! 会话启动、控制与终态排序；状态提交和通知不因调用 Future 丢弃而拆开。
use super::*;
use apk_domain::now;
use deviceforge_observability::LogContext;
use futures_util::FutureExt;
use std::{panic::AssertUnwindSafe, time::Duration};
use tokio::sync::OwnedSemaphorePermit;

struct CancelStartOnDrop {
    cancel: Option<CancellationToken>,
    runtime: Option<Arc<Runtime>>,
}
impl Drop for CancelStartOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        // 装配已完成但成功尚未交给调用者时，丢弃仍要收口该会话。
        if let Some(runtime) = &self.runtime {
            runtime.cancel.cancel();
            runtime.cancel_sample();
        }
    }
}

impl PerformanceService {
    pub async fn start(
        &self,
        request: PerformanceStart,
        cancel: CancellationToken,
    ) -> Result<PerformanceSession> {
        self.start_with_context(request, cancel, None).await
    }

    pub async fn start_with_context(
        &self,
        request: PerformanceStart,
        cancel: CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<PerformanceSession> {
        request.validate()?;
        // 只取消本次启动；调用者令牌和装配成功后的会话取消树保持独立。
        let cancel = cancel.child_token();
        let mut start_wait = CancelStartOnDrop {
            cancel: Some(cancel.clone()),
            runtime: None,
        };
        let context = CallContext::new(cancel, deadline);
        context.check()?;
        let tracked = {
            let controls = context.wait(self.0.controls.lock()).await?;
            if controls.closed {
                return Err(Error::Conflict("性能服务正在停止".into()));
            }
            self.0.tracker.token()
        };
        let (binding, owner_token) = match &self.0.source {
            Source::Registered(access) => {
                let (binding, token) =
                    access.admit(&request.target, &context.cancel, context.deadline)?;
                (Some(binding), Some(token))
            }
            Source::Probe(_) => (None, None),
        };
        let permit = self
            .0
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("性能采样并发会话已满".into()))?;
        // 同次固定单调期限和墙钟开始时间；创建、装配及暂停均消耗会话时长。
        let admitted = Instant::now();
        let timestamp = now();
        let (wake, receiver) = watch::channel(0);
        let stop = binding
            .as_ref()
            .map(|binding| binding.owner.cancel.child_token())
            .unwrap_or_else(CancellationToken::new);
        let runtime = Arc::new(Runtime {
            deadline: admitted + Duration::from_secs(u64::from(request.duration_secs)),
            binding,
            sequence: Arc::new(Mutex::new(())),
            wake,
            cancel: stop,
            sample_cancel: StdMutex::new(None),
            sample_in_flight: AtomicBool::new(false),
            unresolved: AtomicBool::new(false),
        });
        start_wait.runtime = Some(runtime.clone());
        let session = PerformanceSession {
            id: uuid::Uuid::new_v4().to_string(),
            source: runtime
                .binding
                .as_ref()
                .map(|binding| binding.reference.clone()),
            request,
            state: PerformanceState::Running,
            revision: 0,
            samples: 0,
            started_at: timestamp,
            updated_at: timestamp,
            error: None,
        };
        let service = self.clone();
        let task_context = context.clone();
        let handle = tokio::spawn(LogContext::propagate(async move {
            let (_tracked, _owner_token) = (tracked, owner_token);
            let mut permit = Some(permit);
            let outcome = AssertUnwindSafe(service.start_inner(
                session.clone(),
                runtime.clone(),
                receiver,
                &mut permit,
                &task_context,
            ))
            .catch_unwind()
            .await;
            let mut outcome = match outcome {
                Ok(result) => result,
                Err(_) => {
                    runtime.mark_unresolved();
                    Err(Error::Dependency("性能会话启动异常".into()))
                }
            };
            if outcome.is_err() {
                runtime.cancel.cancel();
                runtime.cancel_sample();
                let state = if runtime.source_cancelled() || service.0.controls.lock().await.closed
                {
                    PerformanceState::Interrupted
                } else {
                    PerformanceState::Stopped
                };
                let finished = service
                    .finish(
                        &session.id,
                        &runtime,
                        state,
                        Some("性能会话启动未完成".into()),
                    )
                    .await;
                match finished {
                    Ok(()) | Err(Error::NotFound(_)) => {
                        // 创建尚未执行时没有历史记录，也没有需要继续收口的 worker。
                        service.0.controls.lock().await.active.remove(&session.id);
                    }
                    Err(error) => outcome = Err(error),
                }
            }
            outcome
        }));
        let session = context
            .wait(handle)
            .await?
            .map_err(|_| Error::Dependency("性能会话启动异常".into()))??;
        start_wait.cancel = None;
        start_wait.runtime = None;
        Ok(session)
    }

    async fn start_inner(
        &self,
        session: PerformanceSession,
        runtime: Arc<Runtime>,
        receiver: watch::Receiver<u64>,
        permit: &mut Option<OwnedSemaphorePermit>,
        context: &CallContext,
    ) -> Result<PerformanceSession> {
        {
            let mut controls = context.wait(self.0.controls.lock()).await?;
            if controls.closed {
                return Err(Error::Conflict("性能服务正在停止".into()));
            }
            controls.active.insert(
                session.id.clone(),
                Active {
                    runtime: runtime.clone(),
                    handle: None,
                    pending_terminal: None,
                },
            );
        }
        let sequence = context.wait(runtime.sequence.clone().lock_owned()).await?;
        let created = session.clone();
        self.database(runtime.owner(), context, move |store| {
            let _sequence = sequence;
            store.create(created)
        })
        .await?;
        context.check()?;
        if runtime.cancel.is_cancelled() {
            return Err(Error::Conflict("性能服务正在停止".into()));
        }
        if Instant::now() >= runtime.deadline {
            return Err(Error::Timeout);
        }
        let worker_owner = match (&self.0.source, &runtime.binding) {
            (Source::Registered(access), Some(binding)) => {
                binding.check_current(access)?;
                Some(binding.claim(access, &context.cancel, context.deadline)?)
            }
            _ => None,
        };
        let mut controls = context.wait(self.0.controls.lock()).await?;
        if controls.closed || runtime.source_cancelled() {
            return Err(Error::Conflict("性能来源或服务正在停止".into()));
        }
        let active = controls
            .active
            .get_mut(&session.id)
            .ok_or_else(|| Error::Conflict("性能启动已被关闭流程撤销".into()))?;
        let permit = permit.take().expect("启动许可只能移交一次");
        let handle = self.spawn_worker(session.clone(), runtime, receiver, permit, worker_owner);
        active.handle = Some(handle);
        context.check()?;
        Ok(session)
    }

    pub async fn change(&self, id: String, state: PerformanceState) -> Result<PerformanceSession> {
        self.change_with_context(id, state, CancellationToken::new(), None)
            .await
    }

    pub async fn change_with_context(
        &self,
        id: String,
        state: PerformanceState,
        cancel: CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<PerformanceSession> {
        valid_id(&id)?;
        if !matches!(
            state,
            PerformanceState::Paused | PerformanceState::Running | PerformanceState::Stopped
        ) {
            return Err(Error::Invalid("不支持的性能控制状态".into()));
        }
        let context = CallContext::new(cancel, deadline);
        context.check()?;
        let (runtime, owner_token, tracked) = {
            let controls = context.wait(self.0.controls.lock()).await?;
            let runtime = controls
                .active
                .get(&id)
                .filter(|active| active.pending_terminal.is_none())
                .map(|active| active.runtime.clone());
            let token = runtime
                .as_ref()
                .and_then(|runtime| runtime.owner())
                .map(|owner| owner.claim())
                .transpose()?;
            (runtime, token, self.0.tracker.token())
        };
        let service = self.clone();
        let task_context = context.clone();
        let handle = tokio::spawn(LogContext::propagate(async move {
            let (_tracked, _owner_token) = (tracked, owner_token);
            service
                .change_inner(id, runtime, state, &task_context)
                .await
        }));
        context
            .wait(handle)
            .await?
            .map_err(|_| Error::Dependency("性能会话控制异常".into()))?
    }

    async fn change_inner(
        &self,
        id: String,
        runtime: Option<Arc<Runtime>>,
        state: PerformanceState,
        context: &CallContext,
    ) -> Result<PerformanceSession> {
        let Some(runtime) = runtime else {
            let current = self.get_with_context(id, context).await?;
            return if current.state.terminal() && state == PerformanceState::Stopped {
                Ok(current)
            } else {
                Err(Error::Conflict("性能会话没有活动采样器".into()))
            };
        };
        let sequence = context.wait(runtime.sequence.clone().lock_owned()).await?;
        let current_id = id.clone();
        let current = self
            .database(runtime.owner(), context, move |store| {
                store.get(&current_id)
            })
            .await?;
        if current.state.terminal() {
            return if state == PerformanceState::Stopped {
                Ok(current)
            } else {
                Err(Error::Conflict("性能会话已结束".into()))
            };
        }
        let qualified = if state == PerformanceState::Running {
            match (&self.0.source, &runtime.binding) {
                (Source::Registered(access), Some(binding)) => {
                    binding.check_current(access)?;
                    Some(binding.claim(access, &context.cancel, context.deadline)?)
                }
                _ => None,
            }
        } else {
            match (&self.0.source, &runtime.binding) {
                (Source::Registered(access), Some(binding)) => {
                    Some(binding.control_claim(access, &context.cancel, context.deadline)?)
                }
                _ => None,
            }
        };
        let owner = runtime.owner();
        self.database(owner, context, move |store| {
            let (_sequence, _qualified) = (sequence, qualified);
            let current = store.get(&id)?;
            if current.state.terminal() {
                return if state == PerformanceState::Stopped {
                    Ok(current)
                } else {
                    Err(Error::Conflict("性能会话已结束".into()))
                };
            }
            if runtime.source_cancelled() {
                return Err(Error::Conflict("性能来源代际已撤销".into()));
            }
            if state == PerformanceState::Running && current.state == PerformanceState::Paused {
                if runtime.cleanup_failed() {
                    return Err(Error::CleanupFailed);
                }
                if runtime.sample_in_flight.load(Ordering::Acquire) {
                    return Err(Error::Conflict("性能样本仍在收口".into()));
                }
                if runtime.cancel.is_cancelled() || runtime.source_cancelled() {
                    return Err(Error::Conflict("性能来源或服务正在停止".into()));
                }
                if Instant::now() >= runtime.deadline {
                    let completed = store.transition(
                        &id,
                        current.revision,
                        PerformanceState::Completed,
                        None,
                    )?;
                    runtime.wake.send_replace(completed.revision);
                    return Err(Error::Conflict("性能会话已到期".into()));
                }
            }
            let updated = store.transition(&id, current.revision, state, None)?;
            // 先持久化，再取消样本和发送通知；外层取消不会截断这段同步收口。
            if state == PerformanceState::Paused || state == PerformanceState::Stopped {
                runtime.cancel_sample();
            }
            if updated.revision != current.revision {
                runtime.wake.send_replace(updated.revision);
            }
            if state == PerformanceState::Stopped {
                runtime.cancel.cancel();
            }
            Ok(updated)
        })
        .await
    }

    pub(super) async fn finish(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        state: PerformanceState,
        error: Option<String>,
    ) -> Result<()> {
        let outcome = self
            .finish_with_owner(id, runtime, state, error.clone(), runtime.owner())
            .await;
        if let Err(failure) = &outcome
            && !matches!(failure, Error::NotFound(_))
        {
            let pending = PendingTerminal {
                state,
                error,
                failure_code: failure.code(),
                failure: failure.to_string(),
            };
            let mut controls = self.0.controls.lock().await;
            if let Some(active) = controls.active.get_mut(id) {
                active.pending_terminal = Some(pending);
            }
            tracing::warn!(session_id = %id, code = failure.code(), "性能会话终态尚未写入");
        }
        outcome
    }

    async fn finish_with_owner(
        &self,
        id: &str,
        runtime: &Arc<Runtime>,
        state: PerformanceState,
        error: Option<String>,
        owner: Option<Arc<Owner>>,
    ) -> Result<()> {
        let sequence = runtime.sequence.clone().lock_owned().await;
        let id = id.to_owned();
        let notify = runtime.clone();
        self.database(owner, &CallContext::unbounded(), move |store| {
            let _sequence = sequence;
            loop {
                let current = store.get(&id)?;
                if current.state.terminal() {
                    return Ok(());
                }
                match store.transition(&id, current.revision, state, error.clone()) {
                    Err(Error::Conflict(_)) => continue,
                    result => {
                        let updated = result?;
                        notify.wake.send_replace(updated.revision);
                        notify.cancel_sample();
                        return Ok(());
                    }
                }
            }
        })
        .await
    }

    pub async fn shutdown(&self) -> Result<()> {
        let workers = {
            let mut controls = self.0.controls.lock().await;
            controls.closed = true;
            controls
                .active
                .iter_mut()
                .map(|(id, worker)| {
                    (
                        id.clone(),
                        worker.runtime.clone(),
                        worker.handle.take(),
                        worker.pending_terminal.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (_, runtime, _, _) in &workers {
            runtime.cancel.cancel();
            runtime.cancel_sample();
        }
        let mut failure = None;
        for (id, runtime, handle, pending) in workers {
            let joined = if let Some(handle) = handle {
                match handle.await {
                    Ok(result) => result,
                    Err(_) => {
                        runtime.mark_unresolved();
                        Err(Error::Dependency("性能会话停止异常".into()))
                    }
                }
            } else {
                Ok(())
            };
            if let Some(pending) = pending {
                // 入口已知失败才重试历史，不向已排空或已卸载的 owner 登记新工作。
                match self
                    .finish_with_owner(&id, &runtime, pending.state, pending.error.clone(), None)
                    .await
                {
                    Ok(()) => {
                        self.0.controls.lock().await.active.remove(&id);
                    }
                    Err(error) => {
                        tracing::warn!(session_id = %id, original_code = pending.failure_code,
                            code = error.code(), "性能会话历史终态重试失败");
                        if failure.is_none() {
                            failure = Some(error);
                        }
                    }
                }
            } else if let Err(error) = joined {
                // 本次才发生的失败不立即重试；下一次关闭仍可观察并恢复。
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        // 包括启动/控制任务及丢弃外层 await 后仍在执行的真实数据库闭包。
        self.0.tracker.close();
        self.0.tracker.wait().await;
        // 启动任务可能在本次等待中才登记失败，须保留并报告其真实原因。
        if failure.is_none() {
            failure = self
                .0
                .controls
                .lock()
                .await
                .active
                .values()
                .filter_map(|active| active.pending_terminal.as_ref())
                .next()
                .map(PendingTerminal::failure);
        }
        failure.map_or(Ok(()), Err)
    }
}
