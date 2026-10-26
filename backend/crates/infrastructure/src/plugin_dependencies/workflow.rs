//! 用例端口只编排已分离的发现、下载和原子状态提交，失败不覆盖旧绑定。
use super::{
    FilePluginDependencies, check, configurations, deadline,
    preparation::Preparation,
    state::{self, BindingState},
    targets::ResolvedTarget,
};
use apk_domain::{
    Error, ExecutionContext, JobProgress, JobStage, ProgressReporter, Result,
    plugin_dependencies::*,
};
use deviceforge_tool_repository::Repository;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) fn view(target: &ResolvedTarget, state: &BindingState) -> Result<PluginDependencies> {
    let mut statuses = BTreeMap::new();
    for dependency in &target.manifest.dependencies {
        let status = match state.selected.get(&dependency.id) {
            Some(selection)
                if !compatible_version(&dependency.version_requirement, &selection.version) =>
            {
                DependencyStatus::Incompatible
            }
            Some(selection)
                if dependency.entries.iter().all(|entry| {
                    selection
                        .entries
                        .get(entry)
                        .is_some_and(|path| path.is_absolute() && path.is_file())
                }) =>
            {
                DependencyStatus::Ready
            }
            _ => state
                .observations
                .get(&dependency.id)
                .copied()
                .filter(|status| *status != DependencyStatus::Ready)
                .unwrap_or(DependencyStatus::Missing),
        };
        statuses.insert(dependency.id.clone(), status);
    }
    for _ in 0..target.manifest.dependencies.len() {
        let mut changed = false;
        for dependency in &target.manifest.dependencies {
            if statuses.get(&dependency.id) == Some(&DependencyStatus::Ready)
                && dependency
                    .requires
                    .iter()
                    .any(|id| statuses.get(id) != Some(&DependencyStatus::Ready))
            {
                statuses.insert(dependency.id.clone(), DependencyStatus::Missing);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let order = selected_ids(target, &[], false)?;
    let mut preparable = BTreeMap::new();
    for id in order {
        let dependency = target
            .manifest
            .dependencies
            .iter()
            .find(|dependency| dependency.id == id)
            .ok_or_else(|| Error::Invalid("配套依赖未声明".into()))?;
        let own_ready = state.selected.get(&id).is_some_and(|selection| {
            compatible_version(&dependency.version_requirement, &selection.version)
                && dependency.entries.iter().all(|entry| {
                    selection
                        .entries
                        .get(entry)
                        .is_some_and(|path| path.is_absolute() && path.is_file())
                })
        });
        let can_prepare = (own_ready
            || dependency.sources.iter().any(|source| {
                source.platform == Repository::platform() || source.platform == "any"
            }))
            && dependency
                .requires
                .iter()
                .all(|id| preparable.get(id) == Some(&true));
        preparable.insert(id, can_prepare);
    }
    let dependencies: Vec<_> = target
        .manifest
        .dependencies
        .iter()
        .map(|dependency| {
            let selection = state.selected.get(&dependency.id);
            DependencyView {
                id: dependency.id.clone(),
                name: dependency.name.clone(),
                version_requirement: dependency.version_requirement.clone(),
                required: dependency.required,
                status: statuses[&dependency.id],
                source: selection.map(|selection| selection.origin),
                version: selection.map(|selection| selection.version.clone()),
                installable: preparable.get(&dependency.id) == Some(&true),
                message: if statuses[&dependency.id] == DependencyStatus::Ready {
                    None
                } else {
                    Some("依赖缺失、版本不兼容或配套依赖未就绪".into())
                },
            }
        })
        .collect();
    Ok(PluginDependencies {
        target: target.target.clone(),
        revision: state::revision(target, state)?,
        ready: dependencies
            .iter()
            .all(|dependency| !dependency.required || dependency.status == DependencyStatus::Ready),
        dependencies,
    })
}

pub(super) fn selected_ids(
    target: &ResolvedTarget,
    ids: &[String],
    install: bool,
) -> Result<Vec<String>> {
    let mut selected = BTreeSet::new();
    if ids.is_empty() {
        selected.extend(
            target
                .manifest
                .dependencies
                .iter()
                .filter(|dependency| !install || dependency.required)
                .map(|dependency| dependency.id.clone()),
        );
    } else {
        if ids.len() > 128 {
            return Err(Error::TooLarge);
        }
        for id in ids {
            if !target
                .manifest
                .dependencies
                .iter()
                .any(|dependency| &dependency.id == id)
            {
                return Err(Error::Invalid("请求包含未声明的依赖".into()));
            }
            selected.insert(id.clone());
        }
    }
    loop {
        let mut added = Vec::new();
        for dependency in &target.manifest.dependencies {
            if selected.contains(&dependency.id) {
                added.extend(dependency.requires.iter().cloned());
            }
        }
        let count = selected.len();
        selected.extend(added);
        if count == selected.len() {
            break;
        }
    }
    fn visit(
        id: &str,
        target: &ResolvedTarget,
        active: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) -> Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        if !active.insert(id.into()) {
            return Err(Error::Invalid("配套依赖存在循环".into()));
        }
        let dependency = target
            .manifest
            .dependencies
            .iter()
            .find(|dependency| dependency.id == id)
            .ok_or_else(|| Error::Invalid("配套依赖未声明".into()))?;
        for child in &dependency.requires {
            visit(child, target, active, done, order)?;
        }
        active.remove(id);
        done.insert(id.into());
        order.push(id.into());
        Ok(())
    }
    let mut order = Vec::new();
    let mut active = BTreeSet::new();
    let mut done = BTreeSet::new();
    for dependency in &target.manifest.dependencies {
        if selected.contains(&dependency.id) {
            visit(&dependency.id, target, &mut active, &mut done, &mut order)?;
        }
    }
    Ok(order)
}

impl FilePluginDependencies {
    async fn change(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
        install: bool,
    ) -> Result<PluginDependencies> {
        let mut preparation = Preparation::new();
        let result = self
            .change_prepared(
                request,
                cancel,
                context,
                progress,
                install,
                &mut preparation,
            )
            .await;
        self.release_preparation(preparation).await;
        result
    }

    async fn change_prepared(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
        install: bool,
        preparation: &mut Preparation,
    ) -> Result<PluginDependencies> {
        let deadline = deadline(context);
        check(&cancel, deadline)?;
        let _change = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep_until(std::cmp::min(deadline, Instant::now() + Duration::from_secs(2)).into()) => return Err(Error::Conflict("依赖操作繁忙，请稍后重试".into())),
            guard = self.changes.lock() => guard,
        };
        let requested_target = request.target;
        let (target, mut state, configurations) = self
            .work(move |store| {
                let target = store.resolve(requested_target)?;
                let state = state::load(&store.root, &target)?;
                let configurations = configurations::saved(store, &target)?;
                Ok((target, state, configurations))
            })
            .await?;
        if state::revision(&target, &state)? != request.expected_revision {
            return Err(Error::Conflict("依赖修订已变化，请刷新后重试".into()));
        }
        let selected = selected_ids(&target, &request.dependency_ids, install)?;
        progress
            .report(JobProgress::stage(JobStage::Preparing))
            .await?;
        let target_for_index = target.target.clone();
        let index_exists = self
            .work(move |store| Ok(state::path(&store.root, &target_for_index).exists()))
            .await?;
        if target.manifest.dependencies.is_empty() && !index_exists {
            progress
                .report(JobProgress::stage(JobStage::Complete))
                .await?;
            return view(&target, &state);
        }
        let before =
            serde_json::to_vec(&state).map_err(|_| Error::Storage("依赖状态编码失败".into()))?;
        for id in selected {
            let dependency = target
                .manifest
                .dependencies
                .iter()
                .find(|dependency| dependency.id == id)
                .ok_or_else(|| Error::Invalid("配套依赖未声明".into()))?;
            check(&cancel, deadline)?;
            let previous = state.selected.get(&dependency.id).cloned();
            let (found, invalid) = self
                .discover(
                    dependency,
                    &configurations,
                    previous,
                    preparation,
                    cancel.clone(),
                    deadline,
                )
                .await?;
            let selection = match found {
                Some(selection) => Some(selection),
                None if install && !configurations::has_override(dependency, &configurations) => {
                    progress
                        .report(JobProgress {
                            stage: JobStage::Downloading,
                            resource_id: Some(dependency.id.clone()),
                            completed_bytes: 0,
                            total_bytes: None,
                        })
                        .await?;
                    match self
                        .download_dependency(dependency, preparation, cancel.clone(), deadline)
                        .await
                    {
                        Ok(selection) => Some(selection),
                        Err(error) => {
                            if !matches!(error, Error::Cancelled) {
                                let failed_target = target.clone();
                                let revision = request.expected_revision.clone();
                                let id = dependency.id.clone();
                                let code = error.code().to_owned();
                                self.work(move |store| {
                                    super::failures::record(
                                        &store.root,
                                        &failed_target,
                                        revision,
                                        id,
                                        code,
                                    )
                                })
                                .await?;
                            }
                            return Err(error);
                        }
                    }
                }
                None => None,
            };
            if let Some(selection) = selection {
                state.selected.insert(dependency.id.clone(), selection);
                state.observations.remove(&dependency.id);
            } else {
                state.selected.remove(&dependency.id);
                state.observations.insert(
                    dependency.id.clone(),
                    if invalid {
                        DependencyStatus::Incompatible
                    } else {
                        DependencyStatus::Missing
                    },
                );
            }
        }
        state.deployments = target
            .components
            .iter()
            .map(|component| {
                (
                    state::target_key(&DependencyTarget {
                        kind: component.kind,
                        id: component.id.clone(),
                    }),
                    component.deployment_digest.clone(),
                )
            })
            .collect();
        state.publication_identity = target.publication_identity.clone();
        let after =
            serde_json::to_vec(&state).map_err(|_| Error::Storage("依赖状态编码失败".into()))?;
        let empty = target.manifest.dependencies.is_empty();
        let needs_commit = before != after || (!empty && !index_exists);
        if needs_commit && (!empty || index_exists) {
            state.sequence = state
                .sequence
                .checked_add(1)
                .ok_or_else(|| Error::Conflict("依赖修订已达上限".into()))?;
            let commit_until = std::cmp::min(
                deadline,
                Instant::now() + Duration::from_millis(if empty { 50 } else { 1500 }),
            );
            loop {
                check(&cancel, deadline)?;
                let commit_target = target.clone();
                let commit_state = state.clone();
                let commit_cancel = cancel.clone();
                let expected_revision = request.expected_revision.clone();
                let result = self
                    .work(move |store| {
                        check(&commit_cancel, deadline)?;
                        let current = store.resolve(commit_target.target.clone())?;
                        if current.revision != commit_target.revision {
                            return Err(Error::Conflict("提交前部署依赖声明已变化".into()));
                        }
                        state::persist(
                            &store.root,
                            &store.repository,
                            &commit_target,
                            &commit_state,
                            &expected_revision,
                            &commit_cancel,
                            deadline,
                        )
                    })
                    .await;
                match result {
                    Ok(()) => break,
                    Err(Error::Conflict(_)) if Instant::now() < commit_until => {
                        tokio::select! { _ = cancel.cancelled() => return Err(Error::Cancelled), _ = tokio::time::sleep(Duration::from_millis(25)) => {} }
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        let clear_target = target.target.clone();
        self.work(move |store| super::failures::clear(&store.root, &clear_target))
            .await?;
        let output = view(&target, &state)?;
        if progress
            .report(JobProgress::stage(JobStage::Complete))
            .await
            .is_err()
        {
            tracing::warn!("依赖状态已完成，末次进度通知失败；真实结果以已提交修订为准");
        }
        Ok(output)
    }
}

#[async_trait::async_trait]
impl DependencyStore for FilePluginDependencies {
    async fn get(&self, target: DependencyTarget) -> Result<PluginDependencies> {
        self.work(move |store| {
            let target = store.resolve(target)?;
            let mut result = view(&target, &state::load(&store.root, &target)?)?;
            super::failures::apply(&store.root, &mut result)?;
            Ok(result)
        })
        .await
    }

    async fn scan(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        self.change(request, cancel, context, progress, false).await
    }

    async fn install(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        self.change(request, cancel, context, progress, true).await
    }

    async fn forget(&self, target: DependencyTarget) -> Result<()> {
        let _change = tokio::time::timeout(Duration::from_secs(2), self.changes.lock())
            .await
            .map_err(|_| Error::Conflict("依赖清理正在进行".into()))?;
        self.work(move |store| state::forget(&store.root, &store.repository, &target))
            .await
    }
}
