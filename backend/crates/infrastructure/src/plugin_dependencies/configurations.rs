//! 已保存的显式配置只是可选发现候选；默认值不触发路径选择或阻止自动发现。
use super::{discovery::Candidate, files, state::Selection, targets::ResolvedTarget};
use apk_domain::{Result, plugin_dependencies::*};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct Saved {
    source: String,
    values: Value,
}

pub(super) fn saved(
    store: &super::FilePluginDependencies,
    target: &ResolvedTarget,
) -> Result<BTreeMap<String, Value>> {
    let mut values = BTreeMap::new();
    for component in &target.components {
        if !target.manifest.dependencies.iter().any(|dependency| {
            dependency
                .bindings
                .iter()
                .any(|binding| binding.component_id == component.id)
        }) {
            continue;
        }
        let kind = if component.kind == DependencyTargetKind::Browser {
            "browser"
        } else {
            "server"
        };
        let path = store
            .root
            .join("plugin-configurations")
            .join(kind)
            .join(&component.id)
            .join("state.json");
        if !path.exists() {
            continue;
        }
        let configuration: Saved = files::json(&path)?;
        if configuration.source != "defaults" {
            let mut original = configuration.values;
            let path = super::targets::component_root(store, component.kind, &component.id)?
                .join("manifest.json");
            if path.is_file() {
                let manifest: Value = files::json(&path)?;
                if let Some(defaults) = manifest.pointer("/configuration/defaults") {
                    for dependency in &target.manifest.dependencies {
                        for binding in dependency
                            .bindings
                            .iter()
                            .filter(|binding| binding.component_id == component.id)
                        {
                            if defaults
                                .pointer(&binding.config_pointer)
                                .is_some_and(|default| {
                                    original.pointer(&binding.config_pointer) == Some(default)
                                })
                                && let Some(value) = original.pointer_mut(&binding.config_pointer)
                            {
                                *value = Value::Null;
                            }
                        }
                    }
                }
            }
            values.insert(component.id.clone(), original);
        }
    }
    Ok(values)
}

pub(super) fn has_override(dependency: &Dependency, values: &BTreeMap<String, Value>) -> bool {
    dependency.bindings.iter().any(|binding| {
        values
            .get(&binding.component_id)
            .and_then(|value| value.pointer(&binding.config_pointer))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

pub(super) fn candidates(
    dependency: &Dependency,
    values: &BTreeMap<String, Value>,
) -> Vec<Candidate> {
    let mut components = BTreeMap::<&str, BTreeMap<String, PathBuf>>::new();
    for binding in &dependency.bindings {
        let Some(path) = values
            .get(&binding.component_id)
            .and_then(|value| value.pointer(&binding.config_pointer))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        else {
            continue;
        };
        let Ok(path) = files::file(&path) else {
            continue;
        };
        components
            .entry(&binding.component_id)
            .or_default()
            .insert(binding.entry.clone(), path);
    }
    let mut candidates = Vec::new();
    for entries in components.into_values() {
        if dependency.entries.iter().all(|id| entries.contains_key(id)) {
            candidates.push(entries.clone());
        }
        for rule in &dependency.discovery {
            for (id, explicit) in &entries {
                let Some(relative) = rule.entries.get(id) else {
                    continue;
                };
                let mut base = explicit.clone();
                if relative != "." {
                    for _ in Path::new(relative).components() {
                        base.pop();
                    }
                }
                let Ok(mapped) = super::discovery::mapped(&base, &rule.entries, relative == ".")
                else {
                    continue;
                };
                if dependency.entries.iter().all(|id| mapped.contains_key(id))
                    && entries
                        .iter()
                        .all(|(id, value)| mapped.get(id) == Some(value))
                {
                    candidates.push(mapped);
                }
            }
        }
    }
    candidates
        .into_iter()
        .map(|entries| Candidate {
            selection: Selection {
                origin: DependencyOrigin::Local,
                version: String::new(),
                entries,
                key: None,
            },
            lease: None,
            stage: None,
        })
        .collect()
}
