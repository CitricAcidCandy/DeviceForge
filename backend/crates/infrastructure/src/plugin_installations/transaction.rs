//! 可恢复发布事务；活动文件逐个原子替换，以发布状态记录作为提交点。
use super::{FilePluginInstallations, content, paths, prepare::Prepared, storage};
use apk_domain::{Error, Result, plugin_installations::*};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const ACTIVE: [&str; 4] = [
    "manifest.json",
    "market.json",
    "resources.json",
    "installation.json",
];
const JOURNAL_LIMIT: usize = 32 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Journal {
    id: String,
    revision: Option<String>,
    previous: Option<InstalledRelease>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(revision: char) -> InstalledRelease {
        InstalledRelease {
            id: "sample".into(),
            version: "1.0".into(),
            name: "测试".into(),
            description: "恢复测试".into(),
            revision: revision.to_string().repeat(64),
            enabled: false,
            status: InstallationStatus::Installed,
            installed_at: 0,
            components: vec![InstalledComponent {
                id: "browser".into(),
                kind: apk_domain::plugin_packages::PackageKind::Browser,
                version: "1.0".into(),
                revision: revision.to_string().repeat(64),
                entry_path: "dist/index.js".into(),
                entry_url: None,
            }],
            tools: vec![],
            requirements: vec![],
        }
    }

    #[test]
    fn interrupted_transaction_restores_all_active_files_and_record() {
        let directory = tempfile::tempdir().unwrap();
        let root = paths::open_root(directory.path()).unwrap();
        for path in [
            "installations/releases",
            "installations/transactions",
            "browser-plugins/browser",
        ] {
            paths::create_directory(&root, path).unwrap();
        }
        let old = record('a');
        let new = record('b');
        paths::write(&storage::record_path(&root, "sample"), &old).unwrap();
        for relative in active_paths(&old) {
            paths::write_bytes(&root.join(relative), b"old-value").unwrap();
        }
        let journal = Journal {
            id: "sample".into(),
            revision: Some(new.revision.clone()),
            previous: Some(old.clone()),
            files: capture(&root, Some(&old), Some(&new)).unwrap(),
        };
        paths::write(&journal_path(&root), &journal).unwrap();
        paths::write_bytes(
            &root.join("browser-plugins/browser/manifest.json"),
            b"partial-new-value",
        )
        .unwrap();
        recover(&root).unwrap();
        assert_eq!(
            storage::read_optional(&root, "sample")
                .unwrap()
                .unwrap()
                .revision,
            old.revision
        );
        for relative in active_paths(&old) {
            assert_eq!(fs::read(root.join(relative)).unwrap(), b"old-value");
        }
        assert_eq!(
            fs::read_dir(root.join("installations/transactions"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn committed_transaction_keeps_new_state_and_rejects_nonactive_recovery_path() {
        let directory = tempfile::tempdir().unwrap();
        let root = paths::open_root(directory.path()).unwrap();
        for path in [
            "installations/releases",
            "installations/transactions",
            "browser-plugins/browser",
        ] {
            paths::create_directory(&root, path).unwrap();
        }
        let old = record('a');
        let new = record('b');
        paths::write(&storage::record_path(&root, "sample"), &new).unwrap();
        for relative in active_paths(&new) {
            paths::write_bytes(&root.join(relative), b"new-value").unwrap();
        }
        let mut journal = Journal {
            id: "sample".into(),
            revision: Some(new.revision.clone()),
            previous: Some(old),
            files: capture(&root, Some(&new), None).unwrap(),
        };
        paths::write(&journal_path(&root), &journal).unwrap();
        recover(&root).unwrap();
        assert_eq!(
            storage::read_optional(&root, "sample")
                .unwrap()
                .unwrap()
                .revision,
            new.revision
        );
        journal
            .files
            .insert("browser-plugins/browser/private.txt".into(), Some(vec![]));
        assert!(validate_journal(&journal).is_err());
    }
}
fn journal_path(root: &Path) -> PathBuf {
    root.join("installations/transactions")
        .join(format!("{}.json", uuid::Uuid::new_v4()))
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
        if current.as_ref().map(|record| &record.revision) != journal.revision.as_ref() {
            restore(root, &journal)?;
        }
        fs::remove_file(path).map_err(|_| Error::Storage("恢复日志清理失败".into()))?;
    }
    Ok(())
}

pub(super) fn commit(
    store: &FilePluginInstallations,
    prepared: Prepared,
    expected: Option<String>,
) -> Result<InstalledRelease> {
    let _keep_stage = &prepared.stage;
    let current = storage::optional(store, &prepared.info.id)?;
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
    for tool in &prepared.tools {
        let relative = tool
            .destination
            .strip_prefix(&store.root)
            .map_err(|_| Error::Invalid("工具目录越界".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        let parent = relative.rsplit_once('/').unwrap().0;
        paths::create_directory(&store.root, parent)?;
        if tool.destination.exists() {
            content::verify(&tool.destination)?;
        } else {
            fs::rename(&tool.staged, &tool.destination)
                .map_err(|_| Error::Storage("工具发布失败".into()))?;
        }
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
    let journal = Journal {
        id: prepared.info.id.clone(),
        revision: Some(prepared.info.revision.clone()),
        previous: current.clone(),
        files: capture(&store.root, current.as_ref(), Some(&prepared.info))?,
    };
    let journal_path = journal_path(&store.root);
    paths::write(&journal_path, &journal)?;
    paths::write(
        &store
            .root
            .join("installations")
            .join(format!("previous-{}.json", prepared.info.id)),
        &journal,
    )?;
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
        restore(&store.root, &journal)?;
        fs::remove_file(&journal_path).map_err(|_| Error::Storage("回滚日志清理失败".into()))?;
        return Err(error);
    }
    fs::remove_file(journal_path).map_err(|_| Error::Storage("提交日志清理失败".into()))?;
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
    let journal = Journal {
        id: record.id.clone(),
        revision: None,
        previous: Some(record.clone()),
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
        restore(&store.root, &journal)?;
        fs::remove_file(path).map_err(|_| Error::Storage("回滚日志清理失败".into()))?;
        return Err(error);
    }
    fs::remove_file(path).map_err(|_| Error::Storage("删除日志清理失败".into()))?;
    Ok(())
}

pub(super) fn restore_previous(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
) -> Result<InstalledRelease> {
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
        files: capture(&store.root, Some(&current), Some(&previous))?,
    };
    let recovery_path = journal_path(&store.root);
    paths::write(&recovery_path, &reversal)?;
    if let Err(error) = restore(&store.root, &journal) {
        restore(&store.root, &reversal)?;
        fs::remove_file(recovery_path)
            .map_err(|_| Error::Storage("恢复事务日志清理失败".into()))?;
        return Err(error);
    }
    fs::remove_file(recovery_path).map_err(|_| Error::Storage("恢复事务日志清理失败".into()))?;
    Ok(previous)
}
