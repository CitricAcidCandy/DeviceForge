//! 可恢复发布事务；活动文件逐个原子替换，以发布状态记录作为提交点。
use super::{FilePluginInstallations, content, paths, prepare::Prepared, repository, storage};
use apk_domain::{Error, Result, plugin_installations::*};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const ACTIVE: [&str; 6] = [
    "manifest.json",
    "market.json",
    "resources.json",
    "installation.json",
    "dependencies.json",
    ".deviceforge-runtime.json",
];
const JOURNAL_LIMIT: usize = 32 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Journal {
    id: String,
    revision: Option<String>,
    previous: Option<InstalledRelease>,
    #[serde(default)]
    target: Option<InstalledRelease>,
    files: BTreeMap<String, Option<Vec<u8>>>,
}

fn active_paths(record: &InstalledRelease) -> Vec<String> {
    record
        .components
        .iter()
        .flat_map(|component| {
            let root = if component.kind == apk_domain::plugin_packages::PackageKind::Server {
                "plugins"
            } else {
                "browser-plugins"
            };
            ACTIVE
                .into_iter()
                .map(move |name| format!("{root}/{}/{name}", component.id))
        })
        .collect()
}
fn capture(
    root: &Path,
    current: Option<&InstalledRelease>,
    next: Option<&InstalledRelease>,
) -> Result<BTreeMap<String, Option<Vec<u8>>>> {
    let mut result = BTreeMap::new();
    let mut total = 0usize;
    for relative in current.into_iter().chain(next).flat_map(active_paths) {
        validate_release_path(&relative)?;
        let path = root.join(&relative);
        let value = match fs::symlink_metadata(&path) {
            Ok(_) => {
                if paths::file(&path)?.len() > 2 * 1024 * 1024 {
                    return Err(Error::TooLarge);
                }
                Some(fs::read(path).map_err(|_| Error::Storage("旧活动视图备份失败".into()))?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(Error::Storage("旧活动视图不可访问".into())),
        };
        total = total
            .checked_add(value.as_ref().map_or(0, Vec::len))
            .filter(|total| *total <= 4 * 1024 * 1024)
            .ok_or(Error::TooLarge)?;
        result.insert(relative, value);
    }
    Ok(result)
}
fn restore(root: &Path, journal: &Journal) -> Result<()> {
    validate_journal(journal)?;
    for (relative, value) in &journal.files {
        validate_release_path(relative)?;
        let path = root.join(relative);
        match value {
            Some(bytes) => {
                paths::create_directory(root, relative.rsplit_once('/').unwrap().0)?;
                paths::write_bytes(&path, bytes)?;
            }
            None => {
                if fs::symlink_metadata(&path).is_ok() {
                    paths::file(&path)?;
                    fs::remove_file(path).map_err(|_| Error::Storage("活动视图恢复失败".into()))?;
                }
            }
        }
    }
    match &journal.previous {
        Some(previous) => paths::write(&storage::record_path(root, &journal.id), previous)?,
        None => {
            let path = storage::record_path(root, &journal.id);
            if path.exists() {
                paths::file(&path)?;
                fs::remove_file(path).map_err(|_| Error::Storage("安装记录恢复失败".into()))?;
            }
        }
    }
    Ok(())
}
fn validate_journal(journal: &Journal) -> Result<()> {
    apk_domain::plugins::plugin_id(&journal.id)?;
    if let Some(revision) = &journal.revision {
        validate_release_digest(revision)?;
    }
    if let Some(previous) = &journal.previous {
        storage::validate_record(previous)?;
        if previous.id != journal.id {
            return Err(Error::Invalid("事务发布身份不符".into()));
        }
    }
    if let Some(target) = &journal.target {
        storage::validate_record(target)?;
        if target.id != journal.id {
            return Err(Error::Invalid("事务目标发布身份不符".into()));
        }
    }
    if journal.files.len() > 256 {
        return Err(Error::TooLarge);
    }
    let mut total = 0usize;
    for (relative, bytes) in &journal.files {
        validate_release_path(relative)?;
        let parts: Vec<_> = relative.split('/').collect();
        if parts.len() != 3
            || !["plugins", "browser-plugins"].contains(&parts[0])
            || !ACTIVE.contains(&parts[2])
        {
            return Err(Error::Invalid("事务恢复路径越界".into()));
        }
        apk_domain::plugins::plugin_id(parts[1])?;
        total = total
            .checked_add(bytes.as_ref().map_or(0, Vec::len))
            .filter(|total| *total <= 4 * 1024 * 1024)
            .ok_or(Error::TooLarge)?;
    }
    Ok(())
}

fn journal_path(root: &Path) -> PathBuf {
    root.join("installations/transactions")
        .join(format!("{}.json", uuid::Uuid::new_v4()))
}

fn block_journal(root: &Path, journal: &Journal, phase: &str, reason: &str) -> Result<()> {
    let mut record = storage::read_optional(root, &journal.id)?
        .or_else(|| journal.target.clone())
        .or_else(|| journal.previous.clone())
        .ok_or_else(|| Error::Storage("恢复受阻但没有可持久化的发布身份".into()))?;
    if let Some(previous) = &journal.previous {
        record.enabled = previous.enabled;
    }
    storage::block(root, record, phase, reason)?;
    Ok(())
}

/// 回收器保护上一版和未决事务两端的全部资源，日志损坏时停止回收。
pub(super) fn retained_records(root: &Path) -> Result<Vec<InstalledRelease>> {
    let mut records = Vec::new();
    let installations = root.join("installations");
    for (count, entry) in fs::read_dir(&installations)
        .map_err(|_| Error::Storage("上版快照目录不可读".into()))?
        .enumerate()
    {
        if count >= 1024 {
            return Err(Error::TooLarge);
        }
        let path = entry
            .map_err(|_| Error::Storage("上版快照不可读".into()))?
            .path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.starts_with("previous-") && name.ends_with(".json") {
            let journal: Journal = paths::read(&path, JOURNAL_LIMIT)?;
            validate_journal(&journal)?;
            records.extend(journal.previous);
        }
    }
    for (count, entry) in fs::read_dir(installations.join("transactions"))
        .map_err(|_| Error::Storage("回收事务目录不可读".into()))?
        .enumerate()
    {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let path = entry
            .map_err(|_| Error::Storage("回收事务不可读".into()))?
            .path();
        let journal: Journal = paths::read(&path, JOURNAL_LIMIT)?;
        validate_journal(&journal)?;
        records.extend(journal.previous);
        records.extend(journal.target);
    }
    Ok(records)
}

pub(super) fn recover(root: &Path) -> Result<()> {
    for (count, entry) in fs::read_dir(root.join("installations/transactions"))
        .map_err(|_| Error::Storage("安装恢复目录不可读".into()))?
        .enumerate()
    {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let path = entry
            .map_err(|_| Error::Storage("安装恢复条目不可读".into()))?
            .path();
        let journal: Journal = paths::read(&path, JOURNAL_LIMIT)?;
        validate_journal(&journal)?;
        let current = storage::read_optional(root, &journal.id)?;
        let rollback_blocked = current
            .as_ref()
            .and_then(|record| record.failure.as_ref())
            .is_some_and(|failure| failure.phase.starts_with("transaction_rollback"));
        if rollback_blocked
            || current.as_ref().map(|record| &record.revision) != journal.revision.as_ref()
        {
            if restore(root, &journal).is_err() {
                block_journal(
                    root,
                    &journal,
                    "transaction_rollback",
                    "启动时恢复活动文件失败，保留事务日志以供重试",
                )?;
                continue;
            }
        } else if let Some(target) = &journal.target {
            // 提交点已存在时补齐上一版保护，再清除仅由文件事务产生的阻断。
            let snapshot = root
                .join("installations")
                .join(format!("previous-{}.json", journal.id));
            if paths::write(&snapshot, &journal).is_err() {
                block_journal(
                    root,
                    &journal,
                    "transaction_cleanup",
                    "已提交发布的上版快照仍无法写入",
                )?;
                continue;
            }
            if current.as_ref().is_some_and(|record| {
                record.status == InstallationStatus::RecoveryBlocked
                    && record
                        .failure
                        .as_ref()
                        .is_some_and(|failure| failure.phase == "transaction_cleanup")
            }) && paths::write(&storage::record_path(root, &journal.id), target).is_err()
            {
                block_journal(
                    root,
                    &journal,
                    "transaction_cleanup",
                    "已提交发布的恢复状态仍无法写入",
                )?;
                continue;
            }
        }
        if fs::remove_file(path).is_err() {
            let phase = if rollback_blocked
                || current.as_ref().map(|record| &record.revision) != journal.revision.as_ref()
            {
                "transaction_rollback_cleanup"
            } else {
                "transaction_cleanup"
            };
            block_journal(root, &journal, phase, "已恢复稳定视图，但事务日志清理失败")?;
        }
    }
    Ok(())
}

pub(super) fn commit(
    store: &FilePluginInstallations,
    mut prepared: Prepared,
    expected: Option<String>,
) -> Result<InstalledRelease> {
    let _keep_stage = &prepared.stage;
    let current = storage::optional(store, &prepared.info.id)?;
    if current
        .as_ref()
        .is_some_and(InstalledRelease::requires_recovery)
    {
        return Err(Error::Conflict("恢复受阻的发布不能更新".into()));
    }
    prepared.info.enabled = current.as_ref().is_none_or(|record| record.enabled);
    if current.as_ref().map(|record| record.revision.as_str()) != expected.as_deref() {
        return Err(Error::Conflict("安装修订已变化，未覆盖旧发布".into()));
    }
    if current
        .as_ref()
        .is_some_and(|record| record.revision == prepared.info.revision)
    {
        return Err(Error::Conflict("同一发布修订已经安装".into()));
    }
    if current
        .as_ref()
        .is_some_and(|record| record.version == prepared.info.version)
    {
        return Err(Error::Conflict(
            "同一发布版本已绑定其他摘要，请发布新版本".into(),
        ));
    }
    let releases = storage::list(store)?;
    validate_identities(store, &prepared.identities)?;
    for component in &prepared.info.components {
        if releases.iter().any(|release| {
            release.id != prepared.info.id
                && release
                    .components
                    .iter()
                    .any(|other| other.id == component.id)
        }) {
            return Err(Error::Conflict("组件已由另一发布管理".into()));
        }
        let root = storage::component_root(&store.root, component.kind, &component.id);
        if root.join("manifest.json").exists() && !root.join("installation.json").exists() {
            return Err(Error::Conflict("组件目录已有非托管部署".into()));
        }
    }
    let repository = repository::open(&store.root)?;
    let writer = repository.write().map_err(repository::error)?;
    repository::sync(store, &writer, std::slice::from_ref(&prepared.info))?;
    for tool in &prepared.tools {
        let key = repository
            .key_for_entry(&tool.destination.join("__entry__"))
            .map_err(repository::error)?;
        let stage = repository.stage().map_err(repository::error)?;
        let payload = stage.path().join("payload");
        fs::rename(&tool.staged, &payload)
            .map_err(|_| Error::Storage("共享工具暂存移交失败".into()))?;
        writer
            .publish(&key, &payload, &|| Ok(()))
            .map_err(repository::error)?;
    }
    // 准备与提交之间复用内容可能变化；提交点前在同一写锁下重新验证所有工具。
    for tool in &prepared.info.tools {
        writer
            .verify(&repository::key(tool), &|| Ok(()))
            .map_err(repository::error)?;
    }
    for identity in &prepared.identities {
        let relative = format!(
            "installations/identities/{}/{}/{}",
            identity.kind, identity.id, identity.version
        );
        let directory = paths::create_directory(&store.root, &relative)?;
        let path = directory.join(format!("{}.json", identity.platform));
        if !path.exists() {
            paths::write(&path, identity)?;
        }
    }
    for component in &prepared.components {
        let parent = if component.info.kind == apk_domain::plugin_packages::PackageKind::Server {
            "plugins"
        } else {
            "browser-plugins"
        };
        let relative = format!("{parent}/{}/revisions", component.info.id);
        let revisions = paths::create_directory(&store.root, &relative)?;
        let destination = revisions.join(&prepared.info.revision);
        if destination.exists() {
            content::verify(&destination)?;
        } else {
            fs::rename(&component.staged, &destination)
                .map_err(|_| Error::Storage("组件版本发布失败".into()))?;
        }
    }
    paths::write(
        &store
            .root
            .join("installations/manifests")
            .join(format!("{}.json", prepared.info.revision)),
        &prepared.manifest,
    )?;
    if let Some(base) = &prepared.dependency_base {
        let origins = paths::create_directory(&store.root, "installations/dependency-origins")?;
        paths::write(
            &origins.join(format!("{}.json", prepared.info.revision)),
            &serde_json::json!({"format_version":1,"base_url":base}),
        )?;
    }
    let journal = Journal {
        id: prepared.info.id.clone(),
        revision: Some(prepared.info.revision.clone()),
        previous: current.clone(),
        target: Some(prepared.info.clone()),
        files: capture(&store.root, current.as_ref(), Some(&prepared.info))?,
    };
    let journal_path = journal_path(&store.root);
    paths::write(&journal_path, &journal)?;
    let outcome = (|| {
        if let Some(current) = &current {
            for relative in active_paths(current) {
                let path = store.root.join(relative);
                if path.exists() {
                    paths::file(&path)?;
                    fs::remove_file(path)
                        .map_err(|_| Error::Storage("旧活动视图撤销失败".into()))?;
                }
            }
        }
        for component in &prepared.components {
            let root =
                storage::component_root(&store.root, component.info.kind, &component.info.id);
            let version = root.join("revisions").join(&prepared.info.revision);
            for name in ACTIVE {
                if ["dependencies.json", ".deviceforge-runtime.json"].contains(&name)
                    && !version.join(name).exists()
                {
                    continue;
                }
                let bytes = fs::read(paths::existing(&version, name)?)
                    .map_err(|_| Error::Storage("组件活动视图读取失败".into()))?;
                paths::write_bytes(&root.join(name), &bytes)?;
            }
        }
        paths::write(
            &storage::record_path(&store.root, &prepared.info.id),
            &prepared.info,
        )
    })();
    if let Err(error) = outcome {
        if restore(&store.root, &journal).is_err() {
            block_journal(
                &store.root,
                &journal,
                "transaction_rollback",
                "切换失败且旧活动文件恢复失败",
            )?;
            return Err(Error::Storage("发布回滚受阻，请检查安装状态".into()));
        }
        if fs::remove_file(&journal_path).is_err() {
            block_journal(
                &store.root,
                &journal,
                "transaction_rollback_cleanup",
                "切换已回滚，但日志清理失败",
            )?;
        }
        return Err(error);
    }
    if paths::write(
        &store
            .root
            .join("installations")
            .join(format!("previous-{}.json", prepared.info.id)),
        &journal,
    )
    .is_err()
        || fs::remove_file(journal_path).is_err()
    {
        block_journal(
            &store.root,
            &journal,
            "transaction_cleanup",
            "发布已切换，但上版快照或事务日志写入清理失败",
        )?;
        return Err(Error::Storage("发布提交清理受阻，请检查安装状态".into()));
    }
    repository::sync(store, &writer, &[])?;
    Ok(prepared.info)
}

pub(super) fn validate_identities(
    store: &FilePluginInstallations,
    identities: &[super::prepare::ResourceIdentity],
) -> Result<()> {
    for identity in identities {
        let relative = format!(
            "installations/identities/{}/{}/{}/{}.json",
            identity.kind, identity.id, identity.version, identity.platform
        );
        validate_release_path(&relative)?;
        let path = store.root.join(relative);
        if path.exists() {
            let old: super::prepare::ResourceIdentity = paths::read(&path, 16 * 1024)?;
            if old.kind != identity.kind
                || old.id != identity.id
                || old.version != identity.version
                || old.platform != identity.platform
                || old.sha256 != identity.sha256
            {
                return Err(Error::Conflict("同一标识、版本和平台已绑定其他摘要".into()));
            }
        }
    }
    Ok(())
}

pub(super) fn delete(store: &FilePluginInstallations, record: &InstalledRelease) -> Result<()> {
    let repository = repository::open(&store.root)?;
    let writer = repository.write().map_err(repository::error)?;
    repository::sync(store, &writer, &[])?;
    let journal = Journal {
        id: record.id.clone(),
        revision: None,
        previous: Some(record.clone()),
        target: None,
        files: capture(&store.root, Some(record), None)?,
    };
    let path = journal_path(&store.root);
    paths::write(&path, &journal)?;
    let result = (|| {
        for relative in active_paths(record) {
            let target = store.root.join(relative);
            if target.exists() {
                paths::file(&target)?;
                fs::remove_file(target).map_err(|_| Error::Storage("活动视图删除失败".into()))?;
            }
        }
        fs::remove_file(storage::record_path(&store.root, &record.id))
            .map_err(|_| Error::Storage("安装记录删除失败".into()))
    })();
    if let Err(error) = result {
        if restore(&store.root, &journal).is_err() {
            block_journal(
                &store.root,
                &journal,
                "transaction_rollback",
                "删除失败且活动文件恢复失败",
            )?;
            return Err(Error::Storage("删除回滚受阻，请检查安装状态".into()));
        }
        if fs::remove_file(path).is_err() {
            block_journal(
                &store.root,
                &journal,
                "transaction_rollback_cleanup",
                "删除已回滚，但事务日志清理失败",
            )?;
            return Err(Error::Storage("回滚日志清理受阻，请检查安装状态".into()));
        }
        return Err(error);
    }
    if fs::remove_file(path).is_err() {
        block_journal(
            &store.root,
            &journal,
            "transaction_cleanup",
            "删除活动文件已完成，但事务日志清理失败",
        )?;
        return Err(Error::Storage("删除清理受阻，请检查安装状态".into()));
    }
    repository::sync(store, &writer, &[])
}

pub(super) fn restore_previous(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
) -> Result<InstalledRelease> {
    let repository = repository::open(&store.root)?;
    let writer = repository.write().map_err(repository::error)?;
    repository::sync(store, &writer, &[])?;
    storage::require_revision(store, id, expected)?;
    let path = store
        .root
        .join("installations")
        .join(format!("previous-{id}.json"));
    let journal: Journal = paths::read(&path, JOURNAL_LIMIT)?;
    validate_journal(&journal)?;
    let previous = journal
        .previous
        .as_ref()
        .ok_or_else(|| Error::Conflict("没有可恢复的上版发布".into()))?
        .clone();
    if journal.id != id || journal.revision.as_deref() != Some(expected) {
        return Err(Error::Conflict("上版恢复标识不匹配".into()));
    }
    let current = storage::require_revision(store, id, expected)?;
    // 恢复自身也有提交点，重启时可回到恢复前的新版本或完整恢复的旧版本。
    let reversal = Journal {
        id: id.to_owned(),
        revision: Some(previous.revision.clone()),
        previous: Some(current.clone()),
        target: Some(previous.clone()),
        files: capture(&store.root, Some(&current), Some(&previous))?,
    };
    let recovery_path = journal_path(&store.root);
    paths::write(&recovery_path, &reversal)?;
    if let Err(error) = restore(&store.root, &journal) {
        if restore(&store.root, &reversal).is_err() {
            block_journal(
                &store.root,
                &reversal,
                "transaction_rollback",
                "恢复上版失败，反向回滚也未完成",
            )?;
            return Err(Error::Storage("上版恢复受阻，请检查安装状态".into()));
        }
        if fs::remove_file(recovery_path).is_err() {
            block_journal(
                &store.root,
                &reversal,
                "transaction_rollback_cleanup",
                "恢复上版已回滚，但事务日志清理失败",
            )?;
            return Err(Error::Storage(
                "恢复事务日志清理受阻，请检查安装状态".into(),
            ));
        }
        return Err(error);
    }
    if paths::write(&path, &reversal).is_err() || fs::remove_file(recovery_path).is_err() {
        block_journal(
            &store.root,
            &reversal,
            "transaction_cleanup",
            "上版恢复已完成，但事务日志清理失败",
        )?;
        return Err(Error::Storage("上版恢复清理受阻，请检查安装状态".into()));
    }
    repository::sync(store, &writer, &[])?;
    Ok(previous)
}

#[cfg(test)]
#[path = "transaction_tests.rs"]
mod tests;
