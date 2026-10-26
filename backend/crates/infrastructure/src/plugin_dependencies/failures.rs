//! 失败诊断独立于有效绑定提交，不能为展示失败而破坏先前可用快照。
use super::{files, state, targets::ResolvedTarget};
use apk_domain::{Result, plugin_dependencies::*};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize, Deserialize)]
struct Failures {
    revision: String,
    items: BTreeMap<String, String>,
}

fn path(root: &Path, target: &DependencyTarget) -> PathBuf {
    root.join("plugin-dependencies/failures")
        .join(format!("{}.json", state::target_key(target)))
}

pub(super) fn record(
    root: &Path,
    target: &ResolvedTarget,
    revision: String,
    id: String,
    code: String,
) -> Result<()> {
    let destination = path(root, &target.target);
    let mut failure = if destination.exists() {
        files::json::<Failures>(&destination)?
    } else {
        Failures::default()
    };
    if failure.revision != revision {
        failure.items.clear();
    }
    failure.revision = revision;
    failure.items.insert(
        id,
        format!("依赖安装失败（{code}），已保留原有工具及绑定，可重试安装"),
    );
    files::write(&destination, &failure)
}

pub(super) fn clear(root: &Path, target: &DependencyTarget) -> Result<()> {
    let destination = path(root, target);
    if destination.exists() {
        files::file(&destination)?;
        std::fs::remove_file(destination).map_err(files::io)?;
    }
    Ok(())
}

pub(super) fn apply(root: &Path, view: &mut PluginDependencies) -> Result<()> {
    let destination = path(root, &view.target);
    if !destination.exists() {
        return Ok(());
    }
    let failures: Failures = files::json(&destination)?;
    if failures.revision != view.revision {
        return Ok(());
    }
    for dependency in &mut view.dependencies {
        if dependency.status != DependencyStatus::Ready
            && let Some(message) = failures.items.get(&dependency.id)
        {
            dependency.status = DependencyStatus::Failed;
            dependency.message = Some(message.clone());
        }
    }
    Ok(())
}
