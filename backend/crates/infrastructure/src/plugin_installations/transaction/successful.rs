//! 独立保存最近两份宿主激活成功证据；普通事务 previous 永远不自动升级为成功包。
use super::*;

#[derive(Clone, Serialize, Deserialize)]
struct SuccessSnapshot {
    evidence: SuccessfulRelease,
    files: BTreeMap<String, Option<Vec<u8>>>,
}

#[derive(Default, Serialize, Deserialize)]
struct History {
    format_version: u32,
    entries: Vec<SuccessSnapshot>,
}

fn history_path(root: &Path, id: &str) -> PathBuf {
    root.join("installations/successful")
        .join(format!("{id}.json"))
}

fn read(root: &Path, id: &str) -> Result<History> {
    apk_domain::plugins::plugin_id(id)?;
    let path = history_path(root, id);
    if !path
        .try_exists()
        .map_err(|_| Error::Storage("成功版本记录不可访问".into()))?
    {
        return Ok(History {
            format_version: 1,
            entries: Vec::new(),
        });
    }
    let history: History = paths::read(&path, JOURNAL_LIMIT)?;
    if history.format_version != 1 || history.entries.len() > 2 {
        return Err(Error::Invalid("成功版本记录格式或数量不符".into()));
    }
    for snapshot in &history.entries {
        let release = &snapshot.evidence.release;
        storage::validate_record(release)?;
        if release.id != id || !release.enabled || release.status != InstallationStatus::Enabled {
            return Err(Error::Invalid(
                "成功版本记录的发布身份或激活状态不符".into(),
            ));
        }
        let allowed: std::collections::BTreeSet<_> = active_paths(release).into_iter().collect();
        if snapshot.files.keys().any(|path| !allowed.contains(path))
            || snapshot.files.len() != allowed.len()
        {
            return Err(Error::Invalid(
                "成功版本快照超出所属组件活动文件范围".into(),
            ));
        }
        validate_journal(&Journal {
            id: id.into(),
            revision: Some(release.revision.clone()),
            previous: Some(release.clone()),
            target: None,
            files: snapshot.files.clone(),
        })?;
    }
    Ok(history)
}

pub(in crate::plugin_installations) fn retained_records(
    root: &Path,
) -> Result<Vec<InstalledRelease>> {
    let directory = root.join("installations/successful");
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(Error::Storage("成功版本引用目录不可读".into())),
    };
    let mut records = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= 512 {
            return Err(Error::TooLarge);
        }
        let name = entry
            .map_err(|_| Error::Storage("成功版本引用不可读".into()))?
            .file_name();
        let id = name
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .ok_or_else(|| Error::Invalid("成功版本记录文件名无效".into()))?;
        records.extend(
            read(root, id)?
                .entries
                .into_iter()
                .map(|entry| entry.evidence.release),
        );
    }
    Ok(records)
}

pub(in crate::plugin_installations) fn mark(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
) -> Result<()> {
    let current = storage::require_revision(store, id, expected)?;
    if !current.enabled || current.status != InstallationStatus::Enabled {
        return Err(Error::Conflict(
            "只有完成整套宿主激活的发布才能登记成功版本".into(),
        ));
    }
    let mut history = read(&store.root, id)?;
    if history
        .entries
        .first()
        .is_some_and(|entry| entry.evidence.release.revision == expected)
    {
        return Ok(());
    }
    let repository = repository::open(&store.root)?;
    let writer = repository.write().map_err(repository::error)?;
    let snapshot = SuccessSnapshot {
        evidence: SuccessfulRelease {
            release: current.clone(),
            activated_at: apk_domain::now(),
            scope: SuccessfulReleaseScope::HostActivation,
        },
        files: capture(&store.root, Some(&current), None)?,
    };
    // 活动视图必须完整属于当前发布，不能因磁盘记录被外部改写而登记其他组件。
    validate_active_owners(&store.root, &current)?;
    history
        .entries
        .retain(|entry| entry.evidence.release.revision != expected);
    history.entries.insert(0, snapshot);
    history.entries.truncate(2);
    paths::create_directory(&store.root, "installations/successful")?;
    paths::write(&history_path(&store.root, id), &history)?;
    repository::sync(store, &writer, &[])
}

fn choose(store: &FilePluginInstallations, id: &str, expected: &str) -> Result<SuccessSnapshot> {
    storage::require_revision(store, id, expected)?;
    read(&store.root, id)?
        .entries
        .into_iter()
        .find(|snapshot| snapshot.evidence.release.revision != expected)
        .ok_or_else(|| Error::Conflict("没有不同于当前修订且已登记宿主激活成功的上一版".into()))
}

pub(in crate::plugin_installations) fn previous(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
) -> Result<SuccessfulRelease> {
    Ok(choose(store, id, expected)?.evidence)
}

fn check(context: apk_domain::ExecutionContext) -> Result<()> {
    if context
        .deadline
        .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

fn validate_active_owners(root: &Path, release: &InstalledRelease) -> Result<()> {
    for component in &release.components {
        let directory = storage::component_root(root, component.kind, &component.id);
        let marker: serde_json::Value = paths::read(&directory.join("installation.json"), 65536)?;
        if marker["release_id"] != release.id
            || marker["component_id"] != component.id
            || marker["revision"] != release.revision
        {
            return Err(Error::Conflict("活动组件不再属于当前整套发布修订".into()));
        }
    }
    Ok(())
}

pub(in crate::plugin_installations) fn restore_successful(
    store: &FilePluginInstallations,
    id: &str,
    expected: &str,
    target_revision: &str,
    context: apk_domain::ExecutionContext,
) -> Result<InstalledRelease> {
    check(context)?;
    let current = storage::require_revision(store, id, expected)?;
    if current.requires_recovery() {
        return Err(Error::Conflict("文件事务恢复受阻，不能覆盖未决状态".into()));
    }
    let snapshot = choose(store, id, expected)?;
    let mut target = snapshot.evidence.release;
    if target.revision != target_revision {
        return Err(Error::Conflict("上一成功版本已变化，请重新预览".into()));
    }
    validate_active_owners(&store.root, &current)?;
    let releases = storage::list(store)?;
    for component in &target.components {
        check(context)?;
        if releases.iter().any(|release| {
            release.id != id
                && release
                    .components
                    .iter()
                    .any(|other| other.id == component.id)
        }) {
            return Err(Error::Conflict("待恢复组件已由另一整套发布管理".into()));
        }
        let root = storage::component_root(&store.root, component.kind, &component.id);
        if root.join("manifest.json").exists()
            && !current
                .components
                .iter()
                .any(|current| current.id == component.id)
        {
            return Err(Error::Conflict("待恢复组件目录已有其他活动部署".into()));
        }
        let version = root.join("revisions").join(&target.revision);
        paths::directory(&version)?;
        content::verify_checked(&version, &|| check(context))?;
    }
    let repository = repository::open(&store.root)?;
    let writer = repository.write().map_err(repository::error)?;
    repository::sync(store, &writer, &[])?;
    for tool in &target.tools {
        check(context)?;
        writer
            .verify(&repository::key(tool), &|| {
                if context
                    .deadline
                    .is_some_and(|deadline| std::time::Instant::now() >= deadline)
                {
                    Err(deviceforge_tool_repository::Error::Timeout)
                } else {
                    Ok(())
                }
            })
            .map_err(repository::error)?;
    }
    // 恢复只切代码与所属活动视图；启停意图取本次当前值，配置和业务数据不在事务文件集。
    target.enabled = current.enabled;
    target.status = InstallationStatus::Installed;
    target.failure = None;
    let reversal = Journal {
        id: id.into(),
        revision: Some(target.revision.clone()),
        previous: Some(current.clone()),
        target: Some(target.clone()),
        files: capture(&store.root, Some(&current), Some(&target))?,
    };
    let mut files: BTreeMap<_, _> = active_paths(&current)
        .into_iter()
        .map(|path| (path, None))
        .collect();
    files.extend(snapshot.files);
    let restoring = Journal {
        id: id.into(),
        revision: Some(expected.into()),
        previous: Some(target.clone()),
        target: None,
        files,
    };
    check(context)?;
    let recovery_path = journal_path(&store.root);
    paths::write(&recovery_path, &reversal)?;
    // 提交开始后沿用原事务：无论调用方是否停止等待，都排空到已提交或已回滚的稳定视图。
    if let Err(error) = restore(&store.root, &restoring) {
        if restore(&store.root, &reversal).is_err() {
            block_journal(
                &store.root,
                &reversal,
                "transaction_rollback",
                "成功包恢复失败且反向恢复未完成",
            )?;
            return Err(Error::Storage("成功包恢复受阻，已保留事务证据".into()));
        }
        fs::remove_file(&recovery_path)
            .map_err(|_| Error::Storage("成功包恢复回滚日志清理失败".into()))?;
        return Err(error);
    }
    if paths::write(
        &store
            .root
            .join("installations")
            .join(format!("previous-{id}.json")),
        &reversal,
    )
    .is_err()
        || fs::remove_file(&recovery_path).is_err()
    {
        block_journal(
            &store.root,
            &reversal,
            "transaction_cleanup",
            "成功包已恢复，但事务收尾未完成",
        )?;
        return Err(Error::Storage("成功包恢复收尾受阻".into()));
    }
    repository::sync(store, &writer, &[])?;
    Ok(target)
}
