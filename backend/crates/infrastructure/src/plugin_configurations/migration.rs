//! 仅在用户配置不存在时复制历史状态；源文件始终保留，已有目标永不覆盖。
use super::{storage, storage::State};
use apk_domain::{Error, Result, plugins::plugin_id};
use serde_json::Value;
use std::path::Path;

pub(super) fn import(root: &Path, legacy: &[std::path::PathBuf], id: &str) -> Result<()> {
    plugin_id(id)?;
    if root.join(id).join("state.json").exists() {
        return Ok(());
    }
    for source in legacy {
        let directory = source.join(id);
        if !directory.join("state.json").exists() {
            continue;
        }
        storage::checked_directory(source, id, false)?;
        let state: State = storage::json(&directory.join("state.json"))?;
        if state.revision >= 1024 || state.applied_revision > state.revision {
            return Err(Error::Invalid("历史插件配置修订无效".into()));
        }
        storage::checked_directory(root, id, true)?;
        // 保留全部存在的不可变修订，状态指针最后发布；中途失败可安全重试。
        for revision in 0..1024 {
            let previous = directory.join(format!("{revision}.json"));
            if previous.exists() {
                let values: Value = storage::json(&previous)?;
                storage::ensure_revision(root, id, revision, &values)?;
            }
        }
        storage::ensure_revision(root, id, state.revision, &state.values)?;
        let _: Value = storage::json(&storage::revision_path(root, id, state.applied_revision))?;
        storage::write(&root.join(id).join("state.json"), &state)?;
        return Ok(());
    }
    Ok(())
}
