//! 环境、PATH、本地目录与整个共享仓库统一发现，不执行 shell 或触发下载。
use super::{
    FilePluginDependencies, configurations, files, preparation::Preparation, state::Selection,
};
use apk_domain::{Error, Result, plugin_dependencies::*};
use deviceforge_tool_repository::{ReadLease, Repository, ToolIndex};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct Candidate {
    pub selection: Selection,
    pub lease: Option<Arc<ReadLease>>,
    pub stage: Option<Arc<tempfile::TempDir>>,
}

pub(super) fn mapped(
    base: &Path,
    entries: &BTreeMap<String, String>,
    file_base: bool,
) -> Result<BTreeMap<String, PathBuf>> {
    entries
        .iter()
        .map(|(id, relative)| {
            let path = if relative == "." {
                base.to_owned()
            } else if file_base {
                base.parent()
                    .ok_or_else(|| Error::Invalid("工具入口没有父目录".into()))?
                    .join(files::relative(relative)?)
            } else {
                base.join(files::relative(relative)?)
            };
            let path = files::file(&path)?;
            Ok((id.clone(), path))
        })
        .collect()
}

fn paths(program: &str) -> Vec<PathBuf> {
    let extensions = if cfg!(windows) && Path::new(program).extension().is_none() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.COM".into())
            .split(';')
            .filter(|value| {
                value.len() <= 8
                    && value.starts_with('.')
                    && value[1..].bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .take(8)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    super::environment::path_directories()
        .into_iter()
        .flat_map(|directory| {
            extensions
                .iter()
                .map(move |extension| directory.join(format!("{program}{extension}")))
        })
        .filter(|path| path.is_file())
        .take(32)
        .collect()
}

pub(super) fn local(root: &Path, dependency: &Dependency) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    for rule in &dependency.discovery {
        let bases: Vec<_> = match rule.kind {
            DiscoveryKind::Environment => super::environment::value(&rule.value)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .into_iter()
                .collect(),
            DiscoveryKind::Path => paths(&rule.value),
            DiscoveryKind::UserDirectory => vec![root.join(&rule.value)],
        };
        for base in bases {
            let Ok(entries) = mapped(&base, &rule.entries, base.is_file()) else {
                continue;
            };
            if dependency
                .entries
                .iter()
                .any(|id| !entries.contains_key(id))
            {
                continue;
            }
            candidates.push(Candidate {
                selection: Selection {
                    origin: if rule.kind == DiscoveryKind::UserDirectory {
                        DependencyOrigin::Local
                    } else {
                        DependencyOrigin::Environment
                    },
                    version: String::new(),
                    entries,
                    key: None,
                },
                lease: None,
                stage: None,
            });
            if candidates.len() >= 64 {
                return candidates;
            }
        }
    }
    candidates.sort_by_key(|candidate| {
        if candidate.selection.origin == DependencyOrigin::Environment {
            0
        } else {
            1
        }
    });
    candidates
}

pub(super) fn shared(
    repository: &Repository,
    dependency: &Dependency,
    index: &ToolIndex,
    lease: Arc<ReadLease>,
    check: &dyn Fn() -> deviceforge_tool_repository::Result<()>,
) -> Result<Vec<Candidate>> {
    let mut candidates = Vec::new();
    for tool in &index.tools {
        check().map_err(super::repository_error)?;
        if tool.key.id != dependency.id || tool.key.platform != Repository::platform() {
            continue;
        }
        let mut mappings: Vec<_> = Vec::new();
        if !tool.entries.is_empty() {
            mappings.push(&tool.entries);
        }
        if tool.entries.is_empty() {
            mappings.extend(
                dependency
                    .sources
                    .iter()
                    .filter(|source| {
                        source.sha256 == tool.key.sha256 && source.platform == tool.key.platform
                    })
                    .map(|source| &source.entries),
            );
            mappings.extend(dependency.discovery.iter().map(|rule| &rule.entries));
        }
        let root = repository
            .path(&tool.key)
            .map_err(super::repository_error)?;
        for mapping in mappings {
            let Ok(entries) = mapped(&root, mapping, false) else {
                continue;
            };
            if dependency
                .entries
                .iter()
                .any(|entry| !entries.contains_key(entry))
            {
                continue;
            }
            if entries.values().any(|entry| !entry.starts_with(&root)) {
                continue;
            }
            match lease.verify(&tool.key, check) {
                Ok(_) => {}
                Err(deviceforge_tool_repository::Error::Cancelled) => return Err(Error::Cancelled),
                Err(deviceforge_tool_repository::Error::Timeout) => return Err(Error::Timeout),
                Err(_) => continue,
            }
            let version = if tool.entries.is_empty() {
                dependency
                    .sources
                    .iter()
                    .find(|source| {
                        source.sha256 == tool.key.sha256 && source.platform == tool.key.platform
                    })
                    .map(|source| source.version.clone())
                    .unwrap_or_else(|| tool.runtime_version.clone())
            } else {
                tool.runtime_version.clone()
            };
            candidates.push(Candidate {
                selection: Selection {
                    origin: DependencyOrigin::Shared,
                    version,
                    entries,
                    key: Some(tool.key.clone()),
                },
                lease: Some(lease.clone()),
                stage: None,
            });
            break;
        }
    }
    Ok(candidates)
}

pub(super) async fn probe(
    dependency: &Dependency,
    mut candidate: Candidate,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<Selection> {
    super::check(&cancel, deadline)?;
    for id in &dependency.entries {
        let path = candidate
            .selection
            .entries
            .get(id)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| Error::Dependency("工具缺少声明的完整入口".into()))?;
        files::file(path)?;
    }
    if let Some(probe) = &dependency.probe {
        let executable = candidate
            .selection
            .entries
            .get(&probe.entry)
            .and_then(|path| path.to_str())
            .ok_or_else(|| Error::Invalid("版本探测入口不可用".into()))?;
        let mut command = deviceforge_tool_process::ToolCommand::new(executable, &probe.args);
        command.environment = deviceforge_tool_process::Environment::Restricted;
        command.directory = Path::new(executable).parent();
        let mut options = deviceforge_tool_process::ExecutionOptions::new(
            std::cmp::min(
                deadline,
                Instant::now() + std::time::Duration::from_millis(probe.timeout_ms),
            )
            .into(),
        );
        options.stdout_limit = 32768;
        options.stderr_limit = 32768;
        let resources = Arc::new((candidate.lease.clone(), candidate.stage.clone()));
        let output = deviceforge_tool_process::capture_with_lease(
            command,
            options,
            cancel.clone(),
            resources,
        )
        .await
        .map_err(|error| match error {
            deviceforge_tool_process::Error::Cancelled => Error::Cancelled,
            deviceforge_tool_process::Error::Timeout => Error::Timeout,
            deviceforge_tool_process::Error::CleanupFailed { .. } => Error::CleanupFailed,
            _ => Error::Dependency("工具版本探测失败".into()),
        })?;
        let mut bytes = output.stdout;
        bytes.extend_from_slice(&output.stderr);
        candidate.selection.version = probe_version(probe, &String::from_utf8_lossy(&bytes))
            .ok_or_else(|| Error::Dependency("工具版本输出不匹配声明".into()))?;
    } else if candidate.selection.version.is_empty() {
        if dependency.version_requirement != "*" {
            return Err(Error::Dependency("外部工具未声明可验证的版本探测".into()));
        }
        candidate.selection.version = "unversioned".into();
    }
    if !compatible_version(
        &dependency.version_requirement,
        &candidate.selection.version,
    ) {
        return Err(Error::Dependency("工具版本不满足声明".into()));
    }
    super::check(&cancel, deadline)?;
    Ok(candidate.selection)
}

impl FilePluginDependencies {
    pub(super) async fn discover(
        &self,
        dependency: &Dependency,
        configurations: &BTreeMap<String, serde_json::Value>,
        previous: Option<Selection>,
        preparation: &mut Preparation,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<(Option<Selection>, bool)> {
        let definition = dependency.clone();
        let configurations = configurations.clone();
        let explicit = configurations::has_override(&definition, &configurations);
        let worker_cancel = cancel.clone();
        let external_previous = previous
            .as_ref()
            .filter(|selection| selection.key.is_none())
            .cloned();
        let candidates = self
            .work(move |store| {
                super::check(&worker_cancel, deadline)?;
                let mut candidates = configurations::candidates(&definition, &configurations);
                if !explicit {
                    candidates.extend(local(&store.root, &definition));
                    candidates.extend(super::local_index::candidates(
                        &store.root,
                        &definition,
                        &worker_cancel,
                        deadline,
                    )?);
                }
                if !explicit && let Some(selection) = external_previous {
                    candidates.push(Candidate {
                        selection,
                        lease: None,
                        stage: None,
                    });
                }
                Ok(candidates)
            })
            .await?;
        let mut invalid = false;
        for candidate in candidates {
            let candidate = self
                .protect_candidate(
                    candidate,
                    &dependency.id,
                    preparation,
                    cancel.clone(),
                    deadline,
                )
                .await?;
            match probe(dependency, candidate, cancel.clone(), deadline).await {
                Ok(selection) => return Ok((Some(selection), invalid)),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(Error::CleanupFailed) => return Err(Error::CleanupFailed),
                Err(Error::Timeout) if Instant::now() >= deadline => return Err(Error::Timeout),
                Err(_) => invalid = true,
            }
        }
        if explicit {
            return Ok((None, true));
        }
        let definition = dependency.clone();
        let worker_cancel = cancel.clone();
        let candidates = self
            .work(move |store| {
                super::check(&worker_cancel, deadline)?;
                let lease = Arc::new(store.repository.read().map_err(super::repository_error)?);
                let check = || super::repository_check(&worker_cancel, deadline);
                let index = lease
                    .tool_index_for(&definition.id, &Repository::platform(), &check)
                    .map_err(super::repository_error)?;
                let mut candidates = shared(
                    &store.repository,
                    &definition,
                    &index,
                    lease.clone(),
                    &check,
                )?;
                if let Some(selection) = previous
                    && let Some(key) = &selection.key
                    && lease.verify(key, &check).is_ok()
                {
                    candidates.insert(
                        0,
                        Candidate {
                            selection,
                            lease: Some(lease),
                            stage: None,
                        },
                    );
                }
                Ok(candidates)
            })
            .await?;
        for candidate in candidates {
            let candidate = self
                .protect_candidate(
                    candidate,
                    &dependency.id,
                    preparation,
                    cancel.clone(),
                    deadline,
                )
                .await?;
            match probe(dependency, candidate, cancel.clone(), deadline).await {
                Ok(selection) => return Ok((Some(selection), invalid)),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(Error::CleanupFailed) => return Err(Error::CleanupFailed),
                Err(Error::Timeout) if Instant::now() >= deadline => return Err(Error::Timeout),
                Err(_) => invalid = true,
            }
        }
        Ok((None, invalid))
    }

    async fn protect_candidate(
        &self,
        mut candidate: Candidate,
        dependency_id: &str,
        preparation: &mut Preparation,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<Candidate> {
        let owner = preparation.owner.clone();
        let dependency_id = dependency_id.to_owned();
        let mut keys = preparation.keys.clone();
        let (candidate, prepared_keys) = self
            .work(move |store| {
                let entries = &candidate.selection.entries;
                let managed: Vec<_> = entries
                    .values()
                    .filter(|entry| entry.starts_with(store.repository.root()))
                    .collect();
                if managed.is_empty() {
                    return Ok((candidate, keys));
                }
                if managed.len() != entries.len() {
                    return Err(Error::Dependency(
                        "单项工具入口不能混用外部与仓库内容".into(),
                    ));
                }
                let lease = match candidate.lease.clone() {
                    Some(lease) => lease,
                    None => Arc::new(store.repository.read().map_err(super::repository_error)?),
                };
                let check = || super::repository_check(&cancel, deadline);
                let mut key = None;
                for entry in managed {
                    let current = lease
                        .verify_entry(entry, &check)
                        .map_err(super::repository_error)?;
                    if key.as_ref().is_some_and(|key| *key != current) {
                        return Err(Error::Dependency("工具入口来自不同仓库包".into()));
                    }
                    key = Some(current);
                }
                if let Some(key) = key {
                    if key.id != dependency_id {
                        return Err(Error::Dependency(
                            "显式配置的仓库工具身份与依赖标识不一致".into(),
                        ));
                    }
                    if !keys.contains(&key) {
                        keys.push(key.clone());
                    }
                    lease
                        .set_references(&owner, &keys)
                        .map_err(super::repository_error)?;
                    candidate.selection.key = Some(key);
                    candidate.lease = Some(lease);
                }
                Ok((candidate, keys))
            })
            .await?;
        preparation.keys = prepared_keys;
        Ok(candidate)
    }
}
