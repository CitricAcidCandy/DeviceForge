//! 队列、设备锁、执行与有界取消清理的任务生命周期。
use crate::{Application, alias_plan::Plan, devices, execution};
use apk_domain::{Error, Job, JobStatus, Result};
use tokio_util::sync::CancellationToken;

pub(crate) struct Admission {
    pub selection: Option<devices::locks::Selection>,
    pub deadline: Option<tokio::time::Instant>,
    pub discovery: Option<std::sync::Arc<devices::attempt::Attempt>>,
    pub completion: std::sync::Arc<crate::completion::Completion>,
}

impl Application {
    pub(crate) async fn run(
        self: &std::sync::Arc<Self>,
        job: &Job,
        plan: Plan,
        token: CancellationToken,
        admission: Admission,
    ) -> Result<()> {
        let Admission {
            selection,
            deadline,
            discovery,
            completion,
        } = admission;
        let _device_guard = match selection {
            Some(selection) => match selection
                .acquire_until(&token, deadline.expect("设备任务已设置期限"))
                .await
            {
                Ok(guard) => Some(guard),
                Err(Error::Cancelled) => {
                    self.commit_cancelled(
                        job.id.clone(),
                        completion.clone(),
                        token.clone(),
                        plan.target.owner.clone(),
                    )
                    .await?;
                    return Ok(());
                }
                Err(error) => return Err(error),
            },
            None => None,
        };
        let _permit = tokio::select! {
            biased;
            _=devices::locks::deadline(deadline)=>return Err(Error::Timeout),
            _ = token.cancelled() => {
                self.commit_cancelled(job.id.clone(), completion.clone(), token.clone(), plan.target.owner.clone()).await?;
                return Ok(());
            },
            permit = self.workers.acquire() => permit.map_err(|e| Error::Dependency(e.to_string()))?,
        };
        // 历史清理诊断不阻止新调用；实际设备互斥与本次取消仍独立生效。
        let owner = plan.target.owner.as_ref();
        let running = self
            .transition_async(job.id.clone(), JobStatus::Running, None, None)
            .await?;
        if running.status.is_terminal() {
            return Ok(());
        }
        crate::operation_budget::check(deadline, Some(&token))?;
        tracing::info!("任务开始执行");
        // 执行Future在终态存储等待前结束作用域，有限清理到期也立即释放其资源守卫。
        let result = {
            let execution = async {
                if let Some(attempt) = &discovery {
                    self.registry.begin_discovery(attempt)?;
                }
                let value = execution::execute_reported(
                    plan.target.executor.as_ref(),
                    &plan.target.operation.id,
                    plan.input.clone(),
                    token.clone(),
                    owner.map(AsRef::as_ref),
                    deadline,
                    crate::job_progress::JobProgressReporter::new(self, job.id.clone()),
                )
                .await?;
                let (projected, directory) = if let Some(attempt) = &discovery {
                    let (value, directory) = devices::observation::candidate(
                        &attempt.provider,
                        &plan.target,
                        &job.id,
                        value,
                        &plan,
                    )?;
                    (value, Some(directory))
                } else {
                    (plan.result(value)?, None)
                };
                // 纯转换可能与其他线程取消或截止点竞争，完成后再次核对才能接受成功。
                crate::operation_budget::check(deadline, Some(&token))?;
                Ok((projected, directory))
            };
            execution::settle(execution, &token, owner.map(AsRef::as_ref), deadline).await
        };
        let (status, output, error, directory) = match result {
            Ok((value, directory)) => (JobStatus::Succeeded, Some(value), None, directory),
            Err(Error::Cancelled) => {
                if let Some(attempt) = &discovery {
                    attempt.reject(devices::attempt::Rejection::Cancelled);
                }
                (JobStatus::Cancelled, None, None, None)
            }
            Err(error) => {
                if let Some(attempt) = &discovery {
                    attempt.reject(devices::attempt::Rejection::from_error(&error));
                }
                tracing::warn!(code = error.code(), "任务执行失败");
                (JobStatus::Failed, None, Some(error.into()), None)
            }
        };
        let terminal = if status == JobStatus::Succeeded {
            self.commit_success(
                job.id.clone(),
                output.expect("成功执行包含结果"),
                plan.target.clone(),
                completion,
                token.clone(),
                deadline,
            )
            .await?
        } else if status == JobStatus::Cancelled {
            self.commit_cancelled(
                job.id.clone(),
                completion,
                token.clone(),
                plan.target.owner.clone(),
            )
            .await?
        } else {
            self.commit_failed(
                job.id.clone(),
                error.expect("失败执行包含原因"),
                completion,
                token.clone(),
                plan.target.owner.clone(),
            )
            .await?
        };
        tracing::info!(status = ?terminal.status, "任务执行已收敛");
        if let Some(attempt) = &discovery {
            if terminal.status == JobStatus::Succeeded {
                if let Some(directory) = directory {
                    self.registry.accept_discovery(attempt, directory)?;
                }
            } else {
                attempt.reject(if terminal.status == JobStatus::Cancelled {
                    devices::attempt::Rejection::Cancelled
                } else {
                    devices::attempt::Rejection::Dependency
                });
            }
        }
        Ok(())
    }
}
