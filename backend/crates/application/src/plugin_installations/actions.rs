//! 显式整套恢复与重载只走原生命周期串行门禁；队列、依赖和激活共用绝对截止点。
use super::*;
use apk_domain::{
    ExecutionContext, JobProgress, JobStage, NoProgress,
    plugins::{PluginInfo, PluginState},
};
use std::time::{Duration, Instant};

fn bounded(mut context: ExecutionContext) -> ExecutionContext {
    let maximum = Instant::now() + Duration::from_secs(30);
    context.deadline = Some(
        context
            .deadline
            .map_or(maximum, |deadline| deadline.min(maximum)),
    );
    context
}
fn check(cancel: &CancellationToken, context: ExecutionContext) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if context
        .deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
    {
        return Err(Error::Timeout);
    }
    Ok(())
}

struct ExpectedComponent {
    id: String,
    generation: String,
    receipt: tokio::sync::oneshot::Sender<PluginInfo>,
}

impl InstallationService {
    /// 调试器选中服务器组件时，归属、发布修订与代次必须在同一整套门禁内再次核验。
    pub async fn reload_component_expected(
        self: &Arc<Self>,
        id: String,
        generation: String,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<PluginInfo> {
        plugin_id(&id)?;
        if generation.is_empty() || generation.len() > 128 {
            return Err(Error::Invalid("组件代次为空或超出长度限制".into()));
        }
        let context = bounded(context);
        check(&cancel, context)?;
        // 此处只定位候选发布，不能作为代次校验；入串行门禁后必须再次核对。
        let releases = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout_at(context.deadline.expect("已建立期限").into(), self.store.list()) => value.map_err(|_| Error::Timeout)??,
        };
        let mut owners = releases.into_iter().filter(|release| {
            release
                .components
                .iter()
                .any(|component| component.kind == PackageKind::Server && component.id == id)
        });
        let owner = owners
            .next()
            .ok_or_else(|| Error::Conflict("所选服务器组件不属于可重载的完整发布".into()))?;
        if owners.next().is_some() {
            return Err(Error::Conflict("所选服务器组件归属不唯一".into()));
        }
        let (receipt, received) = tokio::sync::oneshot::channel();
        self.release_action_expected(
            owner.id,
            owner.revision,
            false,
            cancel,
            context,
            Arc::new(NoProgress),
            Some(ExpectedComponent {
                id,
                generation,
                receipt,
            }),
        )
        .await?;
        received
            .await
            .map_err(|_| Error::Dependency("整套重载未产生当前组件代次回执".into()))
    }

    pub async fn previous_successful(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<SuccessfulRelease> {
        plugin_id(id)?;
        validate_release_digest(expected_revision)?;
        self.store.previous_successful(id, expected_revision).await
    }

    pub async fn reload(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<InstalledRelease> {
        self.release_action(
            id,
            expected_revision,
            false,
            cancel,
            context,
            Arc::new(NoProgress),
        )
        .await
    }

    pub async fn restore_previous_successful(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<InstalledRelease> {
        self.release_action(
            id,
            expected_revision,
            true,
            cancel,
            context,
            Arc::new(NoProgress),
        )
        .await
    }

    /// 原任务入口调用；不能从外层把完整发布拆成托管组件分别管理。
    pub async fn release_action(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        restore: bool,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn apk_domain::ProgressReporter>,
    ) -> Result<InstalledRelease> {
        self.release_action_expected(
            id,
            expected_revision,
            restore,
            cancel,
            context,
            progress,
            None,
        )
        .await
    }

    async fn release_action_expected(
        self: &Arc<Self>,
        id: String,
        expected_revision: String,
        restore: bool,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn apk_domain::ProgressReporter>,
        expected_owner: Option<ExpectedComponent>,
    ) -> Result<InstalledRelease> {
        plugin_id(&id)?;
        validate_release_digest(&expected_revision)?;
        let context = bounded(context);
        check(&cancel, context)?;
        let service = self.clone();
        let waiting_cancel = cancel.clone();
        let (started, mut start) = tokio::sync::oneshot::channel();
        let execution = self.plugins.serialized(move |plugins| async move {
            let _ = started.send(());
            check(&cancel, context)?;
            let current = service.current(&id, &expected_revision).await?;
            if let Some(expected) = &expected_owner {
                if !current.components.iter().any(|component| {
                    component.kind == PackageKind::Server && component.id == expected.id
                }) {
                    return Err(Error::Conflict("所选组件已不属于预览的完整发布".into()));
                }
                let selected = plugins
                    .list()
                    .into_iter()
                    .find(|plugin| plugin.id == expected.id)
                    .ok_or_else(|| Error::Conflict("所选组件已卸载，请重新选择".into()))?;
                if selected.generation != expected.generation
                    || selected.state != PluginState::Loaded
                {
                    return Err(Error::Conflict(
                        "所选组件代次或运行状态已变化，本次未重载新实例".into(),
                    ));
                }
            }
            service.require_recoverable(&current)?;
            service.require_clean_components(&current).await?;
            let target = if restore {
                service
                    .store
                    .previous_successful(&id, &expected_revision)
                    .await?
                    .release
            } else {
                current.clone()
            };
            service.validate_whole_ownership(&current, &target).await?;
            if !restore && !current.enabled {
                return Err(Error::Conflict(
                    "完整发布已停用，请通过原启用入口启动，不把重载当作启用".into(),
                ));
            }
            if plugins.list().iter().any(|plugin| {
                plugin.protected
                    && current
                        .components
                        .iter()
                        .chain(&target.components)
                        .any(|component| {
                            component.kind == PackageKind::Server && component.id == plugin.id
                        })
            }) {
                return Err(Error::Conflict(
                    "整套发布含受保护服务器组件，不能重载或恢复".into(),
                ));
            }
            // 预留同一绝对预算末尾五秒供失败补偿，不在取消或失败后重启预算。
            let work_context = ExecutionContext {
                deadline: context.deadline.map(|deadline| {
                    deadline
                        .checked_sub(Duration::from_secs(5))
                        .unwrap_or(deadline)
                }),
            };
            check(&cancel, work_context)?;
            if !restore {
                service
                    .require_activation_ready(&target, &cancel, work_context)
                    .await?;
            }
            progress
                .report(JobProgress::stage(JobStage::Preparing))
                .await?;
            let old_loaded = service.loaded_components(Some(&current));
            check(&cancel, work_context)?;
            if let Err(error) = service
                .unload_bounded(&plugins, &current, work_context)
                .await
            {
                return service
                    .compensate(&plugins, &current, &old_loaded, context, error)
                    .await;
            }
            if let Err(error) = check(&cancel, work_context) {
                return service
                    .compensate(&plugins, &current, &old_loaded, context, error)
                    .await;
            }
            let selected = if restore {
                let _ = progress
                    .report(JobProgress::stage(JobStage::Deploying))
                    .await;
                match service
                    .store
                    .restore_previous_successful(
                        &id,
                        &expected_revision,
                        &target.revision,
                        work_context,
                    )
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        let latest = service.store.get(&id).await?;
                        if latest.revision == current.revision && !latest.requires_recovery() {
                            return service
                                .compensate(&plugins, &current, &old_loaded, context, error)
                                .await;
                        }
                        return Err(error);
                    }
                }
            } else {
                current.clone()
            };
            let _ = progress
                .report(JobProgress::stage(JobStage::Activating))
                .await;
            let activation = async {
                check(&cancel, work_context)?;
                if !selected.enabled {
                    return Ok(selected.clone());
                }
                if !service
                    .dependencies_ready(&selected, &cancel, work_context)
                    .await?
                {
                    return service
                        .store
                        .activation_pending(
                            &id,
                            &selected.revision,
                            selected.enabled,
                            InstallationStatus::DependenciesRequired,
                        )
                        .await;
                }
                if service
                    .configuration_required_bounded(&selected, work_context)
                    .await?
                {
                    return service
                        .store
                        .activation_pending(
                            &id,
                            &selected.revision,
                            selected.enabled,
                            InstallationStatus::ConfigurationRequired,
                        )
                        .await;
                }
                service
                    .enable_bounded(&plugins, &selected, &cancel, work_context)
                    .await
            }
            .await;
            match activation {
                Ok(value) => {
                    if let Some(expected) = expected_owner {
                        let current = plugins
                            .list()
                            .into_iter()
                            .find(|plugin| {
                                plugin.id == expected.id
                                    && plugin.state == PluginState::Loaded
                                    && plugin.generation != expected.generation
                            })
                            .ok_or_else(|| {
                                Error::Dependency("整套重载没有发布选中组件的新代".into())
                            })?;
                        // 回执在持有门禁时取得，不能释放后再读到其他调用的新代。
                        let _ = expected.receipt.send(current);
                    }
                    let _ = progress
                        .report(JobProgress::stage(JobStage::Complete))
                        .await;
                    Ok(value)
                }
                Err(error) => {
                    // 新版本失败后先撤销本次所属组件；恢复动作只通过原反向代码事务补偿。
                    if service
                        .unload_bounded(&plugins, &selected, context)
                        .await
                        .is_err()
                    {
                        return Err(service
                            .blocked_current(
                                &id,
                                "component_cleanup",
                                "整套操作失败且本次组件撤销未完成",
                            )
                            .await);
                    }
                    if restore && selected.revision != current.revision {
                        check(&CancellationToken::new(), context)?;
                        if service
                            .store
                            .restore_previous(&id, &selected.revision)
                            .await
                            .is_err()
                        {
                            return Err(service
                                .blocked_current(
                                    &id,
                                    "activation_rollback",
                                    "成功包激活失败且操作前代码恢复未完成",
                                )
                                .await);
                        }
                    }
                    service
                        .compensate(&plugins, &current, &old_loaded, context, error)
                        .await
                }
            }
        });
        tokio::pin!(execution);
        // 排队等待可以退出；已经取得门禁的事务必须排空，不能遗留晚到发布。
        tokio::select! { biased;
            result = &mut execution => result,
            _ = &mut start => execution.await,
            _ = waiting_cancel.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep_until(context.deadline.expect("已建立期限").into()) => Err(Error::Timeout),
        }
    }

    async fn validate_whole_ownership(
        &self,
        current: &InstalledRelease,
        target: &InstalledRelease,
    ) -> Result<()> {
        if current.id != target.id {
            return Err(Error::Conflict("恢复记录不属于当前整套发布".into()));
        }
        let releases = self.store.list().await?;
        if target.components.iter().any(|component| {
            releases.iter().any(|release| {
                release.id != current.id
                    && release
                        .components
                        .iter()
                        .any(|other| other.id == component.id)
            })
        }) {
            return Err(Error::Conflict("整套发布组件已由另一发布管理".into()));
        }
        Ok(())
    }

    async fn dependencies_ready(
        &self,
        release: &InstalledRelease,
        cancel: &CancellationToken,
        context: ExecutionContext,
    ) -> Result<bool> {
        check(cancel, context)?;
        let deadline = context.deadline.expect("整套用例已建立截止点");
        tokio::select! { biased;
            _ = cancel.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout_at(deadline.into(),self.prepare_dependencies(release,false,cancel.clone(),
                context,Arc::new(NoProgress))) => result.map_err(|_| Error::Timeout)?,
        }
    }

    async fn require_activation_ready(
        &self,
        release: &InstalledRelease,
        cancel: &CancellationToken,
        context: ExecutionContext,
    ) -> Result<()> {
        if !self.dependencies_ready(release, cancel, context).await? {
            return Err(Error::Conflict(
                "整套发布缺少依赖，尚未撤销当前运行实例".into(),
            ));
        }
        if self
            .configuration_required_bounded(release, context)
            .await?
        {
            return Err(Error::Conflict(
                "整套发布缺少必填配置，尚未撤销当前运行实例".into(),
            ));
        }
        check(cancel, context)
    }

    async fn configuration_required_bounded(
        &self,
        release: &InstalledRelease,
        context: ExecutionContext,
    ) -> Result<bool> {
        tokio::time::timeout_at(
            context.deadline.expect("已建立期限").into(),
            self.requires_configuration(release),
        )
        .await
        .map_err(|_| Error::Timeout)?
    }

    async fn unload_bounded(
        &self,
        plugins: &PluginService,
        release: &InstalledRelease,
        context: ExecutionContext,
    ) -> Result<()> {
        for component in release
            .components
            .iter()
            .filter(|component| component.kind == PackageKind::Server)
        {
            check(&CancellationToken::new(), context)?;
            plugins
                .unload_idle_serialized_until(&component.id, context)
                .await?;
        }
        Ok(())
    }

    async fn enable_bounded(
        &self,
        plugins: &PluginService,
        release: &InstalledRelease,
        cancel: &CancellationToken,
        context: ExecutionContext,
    ) -> Result<InstalledRelease> {
        for component in release
            .components
            .iter()
            .filter(|component| component.kind == PackageKind::Server)
        {
            check(cancel, context)?;
            if !plugins
                .list()
                .iter()
                .any(|plugin| plugin.id == component.id)
            {
                plugins
                    .load_serialized_until(&component.id, context)
                    .await?;
            }
        }
        check(cancel, context)?;
        let enabled = self
            .store
            .set_enabled(&release.id, &release.revision, true)
            .await?;
        self.store
            .record_successful_activation(&release.id, &release.revision)
            .await?;
        Ok(enabled)
    }

    async fn compensate(
        &self,
        plugins: &PluginService,
        release: &InstalledRelease,
        old_loaded: &[String],
        context: ExecutionContext,
        error: Error,
    ) -> Result<InstalledRelease> {
        let mut restored = true;
        for id in old_loaded {
            if !plugins.list().iter().any(|plugin| plugin.id == *id)
                && plugins.load_serialized_until(id, context).await.is_err()
            {
                restored = false;
                break;
            }
        }
        if restored {
            return Err(error);
        }
        Err(self
            .blocked(
                release,
                "activation_reload",
                "整套操作失败且原服务器组件恢复未完成",
            )
            .await)
    }
}
