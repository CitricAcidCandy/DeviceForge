//! 操作输入验证、单任务准入与后台任务所有权。
use crate::{Application, devices, registry};
use apk_domain::{Error, Job, JobStatus, Result, now};
use deviceforge_observability::LogContext;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

pub(crate) struct Submission {
    registered: Arc<registry::Registered>,
    plan: crate::alias_plan::Plan,
    discovery: Option<devices::admission::Admission>,
    deadline: Option<tokio::time::Instant>,
}
impl Submission {
    pub fn deadline(&self) -> Option<tokio::time::Instant> {
        self.deadline
    }
}

impl Application {
    pub fn submit(self: &Arc<Self>, operation: &str, input: Value) -> Result<Job> {
        let registered = self.registry.find(operation)?;
        self.submit_registered(operation, input, registered, None)
    }
    pub(crate) fn submit_registered(
        self: &Arc<Self>,
        operation: &str,
        input: Value,
        registered: Arc<registry::Registered>,
        external: Option<CancellationToken>,
    ) -> Result<Job> {
        self.submit_registered_until(operation, input, registered, external, None)
    }
    pub(crate) fn submit_registered_until(
        self: &Arc<Self>,
        operation: &str,
        input: Value,
        registered: Arc<registry::Registered>,
        external: Option<CancellationToken>,
        inherited_deadline: Option<tokio::time::Instant>,
    ) -> Result<Job> {
        let submission = self.prepare_submission(input.clone(), registered, inherited_deadline)?;
        self.submit_prepared(operation, input, submission, external)
            .map(|(job, _)| job)
    }
    pub(crate) fn prepare_submission(
        &self,
        input: Value,
        registered: Arc<registry::Registered>,
        inherited_deadline: Option<tokio::time::Instant>,
    ) -> Result<Submission> {
        let admitted_at = tokio::time::Instant::now();
        registered
            .validator
            .validate(&input)
            .map_err(|e| Error::Invalid(format!("操作输入不符合模式：{e}")))?;
        let plan = crate::alias_plan::Plan::new(&registered, &input)?;
        if !self
            .registry
            .current(&registered.operation.id, &registered)?
        {
            return Err(Error::Conflict("插件贡献已撤销或重载".into()));
        }
        let discovery =
            devices::admission::Admission::prepare(self, &plan, admitted_at, inherited_deadline)?;
        let admission = self.registry.device_admission(&plan.target, &plan.input)?;
        let special = devices::rules::execution_deadline(
            &plan.target,
            admission.as_ref().map(|(_, _, capability)| capability),
            admitted_at,
            None,
        );
        let deadline = crate::operation_budget::deadline(
            &plan.target,
            admitted_at,
            special,
            inherited_deadline,
        );
        crate::operation_budget::check(deadline, None)?;
        Ok(Submission {
            registered,
            plan,
            discovery,
            deadline,
        })
    }
    pub(crate) fn submit_prepared(
        self: &Arc<Self>,
        operation: &str,
        input: Value,
        submission: Submission,
        external: Option<CancellationToken>,
    ) -> Result<(Job, Option<Arc<devices::attempt::Attempt>>)> {
        let Submission {
            registered,
            plan,
            discovery,
            deadline,
        } = submission;
        let mut active = self
            .active
            .lock()
            .map_err(|e| Error::Storage(e.to_string()))?;
        if !active.accepting {
            return Err(Error::Conflict("服务正在停止接收任务".into()));
        }
        if !self.registry.current(operation, &registered)? {
            return Err(Error::Conflict("插件贡献已撤销或重载，请重新提交".into()));
        }
        if registered
            .owner
            .as_ref()
            .is_some_and(|owner| owner.info().cleanup_failed)
        {
            return Err(Error::Conflict("插件资源清理未确认，拒绝新任务".into()));
        }
        if registered
            .owner
            .as_ref()
            .is_some_and(|owner| owner.recovering.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(Error::Conflict("插件正在核对资源，请稍后重试".into()));
        }
        crate::operation_budget::check(deadline, external.as_ref())?;
        let admission = self.registry.device_admission(&plan.target, &plan.input)?;
        let selection = admission
            .map(|(provider, device, cap)| {
                self.device_locks
                    .selection(&provider, device.as_deref(), &cap.scope, &cap.access)
            })
            .transpose()?;
        if active.tokens.len() >= self.capacity {
            return Err(Error::Conflict("任务队列已满".into()));
        }
        let job = Job {
            id: uuid::Uuid::new_v4().to_string(),
            operation: operation.into(),
            input,
            status: JobStatus::Queued,
            result: None,
            error: None,
            created_at: now(),
        };
        let attempt =
            discovery.map(|admission| admission.attempt(job.id.clone(), &plan, external.clone()));
        let token = attempt
            .as_ref()
            .map(|attempt| attempt.token.clone())
            .unwrap_or_else(|| {
                registered
                    .owner
                    .as_ref()
                    .map(|owner| owner.cancel.child_token())
                    .unwrap_or_default()
            });
        let mut creating = crate::submission_reservation::Creating::reserve(
            self,
            &mut active,
            job.id.clone(),
            token.clone(),
            attempt.clone(),
            registered.owner.as_ref(),
            deadline,
        );
        let completion = active
            .completions
            .get(&job.id)
            .cloned()
            .expect("创建预留同步登记提交门禁");
        drop(active);
        if let Err(error) = self.store.create(&job) {
            creating.reject(&error);
            return Err(error);
        }
        let mut active = match self.active.lock() {
            Ok(active) => active,
            Err(_) => {
                return Err(creating.compensate(Error::Storage("创建后的准入状态异常".into())));
            }
        };
        let rechecked = (|| -> Result<()> {
            if let Some(attempt) = &attempt {
                self.registry.track_discovery(attempt)?;
            }
            if !active.accepting {
                return Err(Error::Cancelled);
            }
            if !self.registry.current(operation, &registered)? {
                return Err(Error::Conflict("创建期间插件贡献已撤销".into()));
            }
            if registered
                .owner
                .as_ref()
                .is_some_and(|owner| owner.cancel.is_cancelled())
            {
                return Err(Error::Conflict("创建期间插件正在卸载".into()));
            }
            crate::operation_budget::check(deadline, Some(&token))?;
            if external
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(Error::Cancelled);
            }
            if registered
                .owner
                .as_ref()
                .is_some_and(|owner| owner.info().cleanup_failed)
            {
                return Err(Error::CleanupFailed);
            }
            self.registry.device_admission(&plan.target, &plan.input)?;
            Ok(())
        })();
        if let Err(error) = rechecked {
            drop(active);
            return Err(creating.compensate(error));
        }
        let app = self.clone();
        let queued = job.clone();
        let context = LogContext::current().unwrap_or_default();
        let span = tracing::info_span!("任务", log_id = %context.log_id, job_id = %job.id, operation,
                target_operation = %plan.target.operation.id);
        tracing::info!(parent: &span, "任务已排队");
        let run_attempt = attempt.clone();
        let terminal_owner = plan.target.owner.clone();
        let future = async move {
            context
                .scope(
                    async move {
                        let execution = app.run(&queued, plan, token.clone(), crate::runner::Admission { selection, deadline, discovery: run_attempt.clone(), completion: completion.clone() });
                        let serial = if let Some(attempt) = &run_attempt {
                            tokio::select! {biased;
                                _ = token.cancelled() => Err(Error::Cancelled),
                                _ = async { match &external { Some(token) => token.cancelled().await, None => std::future::pending().await } } => Err(Error::Cancelled),
                                guard = tokio::time::timeout_at(attempt.deadline, attempt.serial.clone().lock_owned()) => guard.map(Some).map_err(|_| Error::Timeout),
                            }
                        } else { Ok(None) };
                        let (serial_guard, serial_error) = match serial { Ok(guard) => (guard, None), Err(error) => (None, Some(error)) };
                        tokio::pin!(execution);
                        let result = if let Some(error) = serial_error { Err(error) } else if let Some(external)=external {
                            tokio::select! {biased; _=external.cancelled()=>{
                                if let Some(attempt) = &run_attempt { attempt.reject(devices::attempt::Rejection::Cancelled); }
                                token.cancel(); execution.await
                            }, result=&mut execution=>result}
                        }else{execution.await};
                        if let Err(error) = result {
                            if let Some(attempt) = &run_attempt { attempt.reject(devices::attempt::Rejection::from_error(&error)); }
                            tracing::error!(code = error.code(), "任务生命周期处理失败");
                            if matches!(error, Error::Cancelled) {
                                let _ = app.commit_cancelled(queued.id.clone(), completion.clone(), token.clone(), terminal_owner.clone()).await;
                            } else {
                              let _ = app.commit_failed(queued.id.clone(), error.into(), completion.clone(), token.clone(), terminal_owner.clone()).await;
                            }
                        }
                        if let Some(attempt) = &run_attempt {
                            app.registry.forget_discovery(attempt);
                        }
                        if let Ok(mut active) = app.active.lock() {
                            active.tokens.remove(&queued.id);
                            active.completions.remove(&queued.id);
                            active.discoveries.remove(&queued.id);
                        }
                        drop(serial_guard);
                        if let Some(attempt) = &run_attempt { attempt.finish(); }
                    }
                    .instrument(span),
                )
                .await
        };
        if let Some(owner) = &registered.owner {
            self.tracker.spawn(owner.tracker.track_future(future));
        } else {
            self.tracker.spawn(future);
        }
        creating.hand_off(&mut active);
        drop(active);
        Ok((job, attempt))
    }
}
