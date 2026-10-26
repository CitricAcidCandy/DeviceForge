//! 来源元数据和仓库引用独立持久化，不向公开资源快照添加私有字段。
use super::{files, targets::ResolvedTarget};
use apk_domain::{Error, Result, plugin_dependencies::*};
use apk_plugin_sdk::resources::{
    ManagedRepository, ManagedResources, ManagedTool, ResourceBinding,
};
use deviceforge_tool_repository::{Repository, ToolKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Selection {
    pub origin: DependencyOrigin,
    pub version: String,
    pub entries: BTreeMap<String, PathBuf>,
    pub key: Option<ToolKey>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct BindingState {
    pub manifest_revision: String,
    pub sequence: u64,
    pub selected: BTreeMap<String, Selection>,
    #[serde(default)]
    pub deployments: BTreeMap<String, String>,
    #[serde(default)]
    pub publication_identity: Option<String>,
    #[serde(default)]
    pub observations: BTreeMap<String, DependencyStatus>,
}

pub(super) fn target_key(target: &DependencyTarget) -> String {
    let kind = match target.kind {
        DependencyTargetKind::Release => "release",
        DependencyTargetKind::Server => "server",
        DependencyTargetKind::Browser => "browser",
    };
    format!("{kind}-{}", target.id)
}

pub(super) fn path(root: &Path, target: &DependencyTarget) -> PathBuf {
    root.join("plugin-dependencies/index")
        .join(format!("{}.json", target_key(target)))
}

pub(super) fn load(root: &Path, target: &ResolvedTarget) -> Result<BindingState> {
    let path = path(root, &target.target);
    if !path.exists() {
        return Ok(BindingState {
            manifest_revision: target.revision.clone(),
            ..Default::default()
        });
    }
    let mut state: BindingState = files::json(&path)?;
    if state.manifest_revision != target.revision {
        state.selected.clear();
        state.observations.clear();
        state.manifest_revision.clone_from(&target.revision);
    }
    Ok(state)
}

pub(super) fn revision(target: &ResolvedTarget, state: &BindingState) -> Result<String> {
    let _ = target;
    let bytes = serde_json::to_vec(state).map_err(|_| Error::Storage("依赖修订编码失败".into()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn snapshot_path(root: &Path, kind: DependencyTargetKind, id: &str) -> PathBuf {
    root.join("plugin-dependencies/bindings")
        .join(if kind == DependencyTargetKind::Browser {
            "browser"
        } else {
            "server"
        })
        .join(format!("{id}.json"))
}

pub(super) fn component_dependencies(
    target: &ResolvedTarget,
    component: &super::targets::Component,
) -> BTreeSet<String> {
    let mut selected: BTreeSet<_> = target
        .manifest
        .dependencies
        .iter()
        .filter(|dependency| {
            dependency
                .bindings
                .iter()
                .any(|binding| binding.component_id == component.id)
        })
        .map(|dependency| dependency.id.clone())
        .collect();
    if let Some(runtime) = &component.runtime {
        selected.insert(runtime.id.clone());
    }
    loop {
        let count = selected.len();
        let required: Vec<_> = target
            .manifest
            .dependencies
            .iter()
            .filter(|dependency| selected.contains(&dependency.id))
            .flat_map(|dependency| dependency.requires.iter().cloned())
            .collect();
        selected.extend(required);
        if count == selected.len() {
            return selected;
        }
    }
}

fn revision_snapshot_path(
    root: &Path,
    kind: DependencyTargetKind,
    id: &str,
    revision: &str,
) -> PathBuf {
    snapshot_path(root, kind, id)
        .with_extension("")
        .join(format!("{revision}.json"))
}

pub(super) fn persist(
    root: &Path,
    repository: &Repository,
    target: &ResolvedTarget,
    state: &BindingState,
    expected: &str,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<()> {
    let _commit = files::state_lock(root)?;
    super::check(cancel, deadline)?;
    if revision(target, &load(root, target)?)? != expected {
        return Err(Error::Conflict("提交前依赖绑定修订已变化".into()));
    }
    let owner = format!(
        "dependencies-{:x}",
        Sha256::digest(target_key(&target.target).as_bytes())
    );
    let keys: Vec<_> = state
        .selected
        .values()
        .filter_map(|selection| selection.key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let old: BindingState = if path(root, &target.target).exists() {
        files::json(&path(root, &target.target))?
    } else {
        BindingState::default()
    };
    let old_keys: Vec<_> = old
        .selected
        .values()
        .filter_map(|selection| selection.key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let lease = if keys.is_empty() && old_keys.is_empty() {
        None
    } else {
        Some(repository.read().map_err(super::repository_error)?)
    };
    let mut retained = keys.clone();
    retained.extend(old_keys.iter().cloned());
    if let Some(lease) = &lease {
        for key in &keys {
            lease
                .verify(key, &|| super::repository_check(cancel, deadline))
                .map_err(super::repository_error)?;
        }
        lease
            .set_references(&owner, &retained)
            .map_err(super::repository_error)?;
    }
    let result = (|| {
        let snapshot_revision = revision(target, state)?;
        for component in &target.components {
            let component_dependencies = component_dependencies(target, component);
            let mut resources = ManagedResources {
                format_version: 1,
                release_id: target.target.id.clone(),
                revision: snapshot_revision.clone(),
                tools: BTreeMap::new(),
                repository: Some(ManagedRepository {
                    format_version: 1,
                    root: repository.root().to_owned(),
                    client_id: format!(
                        "dependency-{:x}",
                        Sha256::digest(
                            target_key(&DependencyTarget {
                                kind: component.kind,
                                id: component.id.clone()
                            })
                            .as_bytes()
                        )
                    ),
                }),
                managed_tools: Some(BTreeMap::new()),
                runtime: component.runtime.as_ref().map(|runtime| {
                    apk_plugin_sdk::packages::RuntimeDependency {
                        id: runtime.id.clone(),
                        entry: runtime.entry.clone(),
                    }
                }),
                bindings: Vec::new(),
            };
            for dependency in &target.manifest.dependencies {
                if !component_dependencies.contains(&dependency.id) {
                    continue;
                }
                let Some(selection) = state.selected.get(&dependency.id) else {
                    continue;
                };
                let bindings: Vec<_> = dependency
                    .bindings
                    .iter()
                    .filter(|binding| binding.component_id == component.id)
                    .map(|binding| ResourceBinding {
                        tool_id: dependency.id.clone(),
                        component_id: component.id.clone(),
                        config_pointer: binding.config_pointer.clone(),
                        entry: binding.entry.clone(),
                    })
                    .collect();
                // 运行时和配套工具可能没有配置绑定，仍须进入入口快照与托管租约身份。
                if let Some(key) = &selection.key {
                    resources
                        .managed_tools
                        .as_mut()
                        .expect("托管工具映射已初始化")
                        .insert(dependency.id.clone(), key.version.clone());
                }
                resources.bindings.extend(bindings);
                resources.tools.insert(
                    dependency.id.clone(),
                    ManagedTool {
                        version: selection.version.clone(),
                        platform: Repository::platform(),
                        entries: selection.entries.clone(),
                    },
                );
            }
            let destination =
                revision_snapshot_path(root, component.kind, &component.id, &snapshot_revision);
            let declared = !component_dependencies.is_empty();
            if declared {
                super::check(cancel, deadline)?;
                if destination.exists() {
                    let previous: serde_json::Value = files::json(&destination)?;
                    if previous
                        != serde_json::to_value(&resources)
                            .map_err(|_| Error::Storage("依赖快照编码失败".into()))?
                    {
                        return Err(Error::Conflict("不可变依赖快照已有不同内容".into()));
                    }
                } else {
                    files::write(&destination, &resources)?;
                }
            }
        }
        // 所有新快照先写为不可变修订；最后只替换单个索引，失败不会切断旧绑定。
        super::check(cancel, deadline)?;
        for (id, selection) in &state.selected {
            super::local_index::register(root, id, selection, cancel, deadline)?;
        }
        files::write(&path(root, &target.target), state)?;
        Ok(())
    })();
    if let Some(lease) = &lease {
        let references = if result.is_ok() { &keys } else { &old_keys };
        if lease.set_references(&owner, references).is_err() {
            tracing::warn!("依赖绑定引用收敛失败，保守保留旧版及本次准备引用待清理");
        }
    }
    result
}

pub(super) fn valid_snapshot(
    root: &Path,
    target: &ResolvedTarget,
    component: &super::targets::Component,
) -> Result<Option<PathBuf>> {
    let index_path = path(root, &target.target);
    if !index_path.exists() {
        return Ok(None);
    }
    let state: BindingState = files::json(&index_path)?;
    let key = target_key(&DependencyTarget {
        kind: component.kind,
        id: component.id.clone(),
    });
    if state.manifest_revision != target.revision
        || state.deployments.get(&key) != Some(&component.deployment_digest)
    {
        return Ok(None);
    }
    checked_snapshot(root, target, component.kind, &component.id, &state)
}

fn checked_snapshot(
    root: &Path,
    target: &ResolvedTarget,
    kind: DependencyTargetKind,
    id: &str,
    state: &BindingState,
) -> Result<Option<PathBuf>> {
    let revision = revision(target, state)?;
    let current = revision_snapshot_path(root, kind, id, &revision);
    let snapshot = if current.exists() {
        current
    } else {
        snapshot_path(root, kind, id)
    };
    if !snapshot.exists() {
        return Ok(None);
    }
    files::file(&snapshot)?;
    let resources =
        ManagedResources::read(&snapshot).map_err(|_| Error::Invalid("依赖绑定快照无效".into()))?;
    if resources.release_id != target.target.id || resources.revision != revision {
        return Ok(None);
    }
    Ok(Some(snapshot))
}

pub(super) fn snapshot_for(
    root: &Path,
    kind: DependencyTargetKind,
    id: &str,
    deployment: &Path,
) -> Result<Option<PathBuf>> {
    apk_domain::plugins::plugin_id(id)?;
    if kind == DependencyTargetKind::Release {
        return Err(Error::Invalid("组件快照不能以完整发布作为组件类型".into()));
    }
    let owners: Vec<_> = super::targets::releases_at(root)?
        .into_iter()
        .filter(|release| {
            release.components.iter().any(|component| {
                component.id == id
                    && ((component.kind == apk_domain::plugin_packages::PackageKind::Browser)
                        == (kind == DependencyTargetKind::Browser))
            })
        })
        .collect();
    if owners.len() > 1 {
        return Err(Error::Conflict("组件同时属于多个完整发布".into()));
    }
    let target = DependencyTarget {
        kind: if owners.is_empty() {
            kind
        } else {
            DependencyTargetKind::Release
        },
        id: owners
            .first()
            .map_or_else(|| id.to_owned(), |release| release.id.clone()),
    };
    let index_path = path(root, &target);
    if !index_path.exists() {
        return Ok(None);
    }
    let state: BindingState = files::json(&index_path)?;
    let key = target_key(&DependencyTarget {
        kind,
        id: id.into(),
    });
    if state.deployments.get(&key) != Some(&super::targets::deployment_digest(deployment)?) {
        return Ok(None);
    }
    if let Some(owner) = owners.first() {
        if state.publication_identity.as_ref()
            != Some(&super::targets::publication_digest(root, owner)?)
        {
            return Ok(None);
        }
    } else if state.publication_identity.is_some() {
        return Ok(None);
    }
    let resolved = ResolvedTarget {
        target,
        revision: state.manifest_revision.clone(),
        manifest: DependencyManifest::default(),
        components: Vec::new(),
        publication_identity: state.publication_identity.clone(),
    };
    checked_snapshot(root, &resolved, kind, id, &state)
}

pub(super) fn forget(
    root: &Path,
    repository: &Repository,
    target: &DependencyTarget,
) -> Result<()> {
    apk_domain::plugins::plugin_id(&target.id)?;
    let _commit = files::state_lock(root)?;
    let index_path = path(root, target);
    if !index_path.exists() {
        return Ok(());
    }
    let state: BindingState = files::json(&index_path)?;
    let lease = if state
        .selected
        .values()
        .any(|selection| selection.key.is_some())
    {
        Some(repository.read().map_err(super::repository_error)?)
    } else {
        None
    };
    let resolved = ResolvedTarget {
        target: target.clone(),
        revision: state.manifest_revision.clone(),
        manifest: DependencyManifest::default(),
        components: Vec::new(),
        publication_identity: state.publication_identity.clone(),
    };
    let expected_revision = revision(&resolved, &state)?;
    let mut owned = Vec::new();
    for key in state.deployments.keys() {
        let (kind, id) = if let Some(id) = key.strip_prefix("server-") {
            (DependencyTargetKind::Server, id)
        } else if let Some(id) = key.strip_prefix("browser-") {
            (DependencyTargetKind::Browser, id)
        } else {
            return Err(Error::Invalid("依赖索引组件身份无效".into()));
        };
        apk_domain::plugins::plugin_id(id)?;
        let current = revision_snapshot_path(root, kind, id, &expected_revision);
        let snapshot = if current.exists() {
            current
        } else {
            snapshot_path(root, kind, id)
        };
        if snapshot.exists() {
            files::file(&snapshot)?;
            let resources = ManagedResources::read(&snapshot)
                .map_err(|_| Error::Invalid("依赖快照损坏，保留引用待检查".into()))?;
            if resources.release_id != target.id || resources.revision != expected_revision {
                return Err(Error::Conflict("依赖快照归属变化，保留引用待检查".into()));
            }
            owned.push(snapshot);
        }
    }
    std::fs::remove_file(index_path).map_err(files::io)?;
    for snapshot in owned {
        std::fs::remove_file(snapshot).map_err(files::io)?;
    }
    if let Some(lease) = lease {
        let owner = format!(
            "dependencies-{:x}",
            Sha256::digest(target_key(target).as_bytes())
        );
        lease
            .set_references(&owner, &[])
            .map_err(super::repository_error)?;
    }
    Ok(())
}
