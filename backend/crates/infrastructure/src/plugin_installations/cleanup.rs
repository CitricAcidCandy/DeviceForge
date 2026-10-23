//! 显式安装资源回收：生命周期门禁内重新计算引用，不接受外部删除路径。
use super::{FilePluginInstallations, paths, repository, storage, transaction};
use apk_domain::{Error, Result, plugin_installations::*};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub(super) fn resources(
    store: &FilePluginInstallations,
    dry_run: bool,
    running_components: &[String],
) -> Result<ResourceCleanupReport> {
    // 事务或准备阶段存在时无法证明缓存没有被后台工作引用，全部保留。
    let transactions = store.root.join("installations/transactions");
    let staging = store.root.join("installations/staging");
    let busy = fs::read_dir(&transactions)
        .map_err(|_| Error::Storage("资源回收事务目录不可读".into()))?
        .next()
        .is_some()
        || fs::read_dir(&staging)
            .map_err(|_| Error::Storage("资源回收暂存目录不可读".into()))?
            .next()
            .is_some();
    if busy {
        return Ok(ResourceCleanupReport {
            dry_run,
            items: vec![],
            total_bytes: 0,
        });
    }
    let repository = repository::open(&store.root)?;
    let writer = match repository.write() {
        Ok(writer) => writer,
        Err(deviceforge_tool_repository::Error::Busy) => {
            return Ok(ResourceCleanupReport {
                dry_run,
                items: vec![],
                total_bytes: 0,
            });
        }
        Err(error) => return Err(repository::error(error)),
    };
    repository::sync(store, &writer, &[])?;
    let mut records = storage::list(store)?;
    records.extend(transaction::retained_records(&store.root)?);
    let mut protected = BTreeSet::new();
    let mut protected_digests = BTreeSet::new();
    let mut unknown_cached_references = false;
    for record in &records {
        for tool in &record.tools {
            protected.insert(format!(
                "tools/{}/{}/{}/{}",
                tool.id, tool.version, tool.platform, tool.sha256
            ));
        }
        for component in &record.components {
            let parent = if component.kind == apk_domain::plugin_packages::PackageKind::Server {
                "plugins"
            } else {
                "browser-plugins"
            };
            protected.insert(format!(
                "{parent}/{}/revisions/{}",
                component.id, component.revision
            ));
        }
        let manifest_path = store
            .root
            .join("installations/manifests")
            .join(format!("{}.json", record.revision));
        if manifest_path.exists() {
            let manifest: ReleaseManifest = paths::read(&manifest_path, RELEASE_MANIFEST_LIMIT)?;
            manifest.validate()?;
            if manifest.id != record.id || manifest.version != record.version {
                return Err(Error::Invalid("回收引用清单身份不匹配".into()));
            }
            protected_digests.extend(
                super::prepare::identities(&manifest, &record.revision)
                    .into_iter()
                    .map(|identity| identity.sha256),
            );
        } else {
            unknown_cached_references = true;
        }
    }
    let resources = store.root.join("installations/resources");
    let mut items = Vec::new();
    let mut candidates = Vec::new();
    for path in children(&resources)? {
        let metadata = paths::file(&path)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| Error::Invalid("资源缓存文件名无效".into()))?;
        apk_domain::plugin_installations::validate_release_digest(name)?;
        if unknown_cached_references || protected_digests.contains(name) {
            continue;
        }
        candidates.push((path.clone(), false, metadata.len()));
    }
    // 正在运行的服务可能仍持有旧工具入口，直到运行退出前保守保留展开工具。
    if running_components.is_empty() {
        for path in directories_at_depth(&store.root.join("tools"), 4)? {
            let relative = relative(&store.root, &path)?;
            let parts: Vec<_> = relative.split('/').collect();
            apk_domain::plugins::plugin_id(parts[1])?;
            validate_release_path(parts[2])?;
            validate_release_path(parts[3])?;
            validate_release_digest(parts[4])?;
            if !protected.contains(&relative) {
                let key = repository
                    .key_for_entry(&path.join("__entry__"))
                    .map_err(repository::error)?;
                if !writer
                    .references(&key)
                    .map_err(repository::error)?
                    .is_empty()
                {
                    continue;
                }
                writer.verify(&key, &|| Ok(())).map_err(repository::error)?;
                candidates.push((path.clone(), true, directory_size(&path)?));
            }
        }
    }
    for parent in ["plugins", "browser-plugins"] {
        if parent == "browser-plugins" && store.readers.available_permits() < 8 {
            continue;
        }
        for component in children(&store.root.join(parent))? {
            paths::directory(&component)?;
            let id = component
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| Error::Invalid("组件回收标识无效".into()))?;
            apk_domain::plugins::plugin_id(id)?;
            if running_components.iter().any(|running| running == id) {
                continue;
            }
            let revisions = component.join("revisions");
            if !revisions.exists() {
                continue;
            }
            for path in children(&revisions)? {
                let relative = relative(&store.root, &path)?;
                let revision = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                validate_release_digest(revision)?;
                if !protected.contains(&relative) {
                    candidates.push((path.clone(), true, directory_size(&path)?));
                }
            }
        }
    }
    if candidates.len() > 32768 {
        return Err(Error::TooLarge);
    }
    // 所有候选先完成路径核对与总量计算，避免已经删除后才发现后续条目越界。
    let total_bytes = candidates.iter().try_fold(0u64, |total, (_, _, bytes)| {
        total.checked_add(*bytes).ok_or(Error::TooLarge)
    })?;
    for (path, _, _) in &candidates {
        let canonical =
            fs::canonicalize(path).map_err(|_| Error::Storage("资源回收路径不可访问".into()))?;
        if canonical != *path || !canonical.starts_with(&store.root) || canonical == store.root {
            return Err(Error::Invalid("资源回收路径越界".into()));
        }
    }
    for (path, directory, bytes) in candidates {
        let resource = relative(&store.root, &path)?;
        let canonical =
            fs::canonicalize(&path).map_err(|_| Error::Storage("资源回收路径不可访问".into()))?;
        if canonical != path || !canonical.starts_with(&store.root) || canonical == store.root {
            return Err(Error::Invalid("资源回收路径越界".into()));
        }
        if !dry_run {
            if resource.starts_with("tools/") {
                let key = repository
                    .key_for_entry(&canonical.join("__entry__"))
                    .map_err(repository::error)?;
                writer.remove(&key, &|| Ok(())).map_err(repository::error)?;
            } else if directory {
                fs::remove_dir_all(&canonical)
                    .map_err(|_| Error::Storage("展开资源删除失败".into()))?;
            } else {
                fs::remove_file(&canonical)
                    .map_err(|_| Error::Storage("资源缓存删除失败".into()))?;
            }
        }
        items.push(ResourceCleanupItem { resource, bytes });
    }
    Ok(ResourceCleanupReport {
        dry_run,
        items,
        total_bytes,
    })
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| Error::Invalid("资源回收路径越界".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    validate_release_path(&relative)?;
    Ok(relative)
}

fn children(root: &Path) -> Result<Vec<PathBuf>> {
    paths::directory(root)?;
    let mut children = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| Error::Storage("资源回收目录不可读".into()))?
    {
        if children.len() >= 32768 {
            return Err(Error::TooLarge);
        }
        children.push(
            entry
                .map_err(|_| Error::Storage("资源回收条目不可读".into()))?
                .path(),
        );
    }
    Ok(children)
}

fn directories_at_depth(root: &Path, depth: usize) -> Result<Vec<PathBuf>> {
    let mut level = vec![root.to_owned()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for directory in level {
            for child in children(&directory)? {
                if directory == root && child.file_name().is_some_and(|name| name == ".repository")
                {
                    continue;
                }
                paths::directory(&child)?;
                next.push(child);
                if next.len() >= 32768 {
                    return Err(Error::TooLarge);
                }
            }
        }
        level = next;
    }
    Ok(level)
}

fn directory_size(root: &Path) -> Result<u64> {
    let mut pending = vec![root.to_owned()];
    let mut count = 0usize;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for child in children(&directory)? {
            count += 1;
            if count > 32768 {
                return Err(Error::TooLarge);
            }
            let metadata = fs::symlink_metadata(&child)
                .map_err(|_| Error::Storage("资源回收条目不可访问".into()))?;
            if metadata.is_dir() {
                paths::directory(&child)?;
                pending.push(child);
            } else {
                bytes = bytes
                    .checked_add(paths::file(&child)?.len())
                    .ok_or(Error::TooLarge)?;
            }
        }
    }
    Ok(bytes)
}
