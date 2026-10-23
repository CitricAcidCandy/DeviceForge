//! 工具供应的共享仓库接缝；选择状态独立于不可变内容，不读取宿主内部记录。
use crate::{
    budget::Budget,
    config::Config,
    error::{Error, Result},
    storage::{self, Installed},
};
use deviceforge_tool_repository::{Repository, ToolKey, WriteGuard};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn repository_error(error: deviceforge_tool_repository::Error) -> Error {
    use deviceforge_tool_repository::Error as Shared;
    match error {
        Shared::Busy => Error::Busy,
        Shared::InUse => Error::Invalid("共享工具仍被活动发布、上版或调用引用"),
        Shared::TooLarge => Error::TooLarge,
        Shared::Cancelled => Error::Cancelled,
        Shared::Timeout => Error::Timeout,
        Shared::Invalid(message) => Error::Invalid(message),
        Shared::Io(_) => Error::Io("共享工具仓库操作失败"),
    }
}
pub(crate) fn check(budget: &Budget) -> deviceforge_tool_repository::Result<()> {
    budget.check().map_err(|error| match error {
        Error::Cancelled => deviceforge_tool_repository::Error::Cancelled,
        _ => deviceforge_tool_repository::Error::Timeout,
    })
}
pub(crate) fn key(state: &Installed) -> ToolKey {
    ToolKey {
        id: state.module_id.clone(),
        version: state.version.clone(),
        platform: Repository::platform(),
        sha256: state.sha256.to_ascii_lowercase(),
    }
}
fn owner(config: &Config) -> Result<String> {
    let client = &config
        .repository
        .as_ref()
        .ok_or(Error::Invalid("缺少托管仓库"))?
        .client_id;
    Ok(format!("client-{:x}", Sha256::digest(client.as_bytes())))
}
pub(crate) fn repository(config: &Config) -> Result<Repository> {
    Repository::open(
        &config
            .repository
            .as_ref()
            .ok_or(Error::Invalid("缺少托管仓库"))?
            .root,
    )
    .map_err(repository_error)
}
pub(crate) fn content_path(config: &Config, state: &Installed, budget: &Budget) -> Result<PathBuf> {
    let repository = repository(config)?;
    let reader = repository.read().map_err(repository_error)?;
    reader
        .verify(&key(state), &|| check(budget))
        .map_err(repository_error)
}
pub(crate) fn references(
    config: &Config,
    writer: &WriteGuard,
    extra: &[ToolKey],
    budget: &Budget,
) -> Result<()> {
    let mut keys = storage::all_installed(config, budget)?
        .iter()
        .map(key)
        .collect::<Vec<_>>();
    keys.extend_from_slice(extra);
    writer
        .set_references(&owner(config)?, &keys)
        .map_err(repository_error)
}
pub(crate) fn publish(
    config: &Config,
    state: &Installed,
    content: &Path,
    transaction: &crate::transaction::Transaction,
    budget: &Budget,
) -> Result<()> {
    let repository = repository(config)?;
    let writer = repository.write().map_err(repository_error)?;
    let key = key(state);
    // 先保留旧选择与新目标；提交中止时多保留引用，不给清理器留下空窗。
    references(config, &writer, std::slice::from_ref(&key), budget)?;
    let stage = repository.stage().map_err(repository_error)?;
    let payload = stage.path().join("payload");
    fs::rename(content, &payload).map_err(|_| Error::Io("移动共享工具暂存失败"))?;
    writer
        .publish(&key, &payload, &|| check(budget))
        .map_err(repository_error)?;
    select(config, state, transaction, &writer, budget)
}
fn select(
    config: &Config,
    state: &Installed,
    transaction: &crate::transaction::Transaction,
    writer: &WriteGuard,
    budget: &Budget,
) -> Result<()> {
    let selection = transaction.path.join("selection");
    storage::directory(&selection)?;
    storage::write_state(&selection, state, budget)?;
    let target = storage::target(config, &state.module_id)?;
    crate::transaction::replace(
        &target,
        &selection,
        &transaction.path.join("backup"),
        budget,
    )?;
    references(config, writer, &[], budget)
}
pub(crate) fn reuse(
    config: &Config,
    state: &Installed,
    transaction: &crate::transaction::Transaction,
    budget: &Budget,
) -> Result<bool> {
    let repository = repository(config)?;
    let writer = repository.write().map_err(repository_error)?;
    let key = key(state);
    let path = repository.path(&key).map_err(repository_error)?;
    if !path.exists() {
        return Ok(false);
    }
    let path = writer
        .verify(&key, &|| check(budget))
        .map_err(repository_error)?;
    let root = path.join(crate::unpack::relative(
        state.archive_root.as_deref().unwrap_or(""),
        true,
    )?);
    if !root.is_dir() {
        return Err(Error::Invalid("共享工具缺少清单归档根"));
    }
    if let Some(entry) = &state.entry_file
        && !root.join(crate::unpack::relative(entry, false)?).is_file()
    {
        return Err(Error::Invalid("共享工具缺少清单声明入口"));
    }
    references(config, &writer, std::slice::from_ref(&key), budget)?;
    select(config, state, transaction, &writer, budget)?;
    Ok(true)
}
pub(crate) fn remove(config: &Config, id: &str, budget: &Budget) -> Result<serde_json::Value> {
    let _module = storage::ModuleLock::acquire(config, id, budget)?;
    let Some(state) = storage::installed(config, id, budget)? else {
        return Ok(serde_json::json!({"module_id":id,"removed":false}));
    };
    let repository = repository(config)?;
    let writer = repository.write().map_err(repository_error)?;
    let tool = key(&state);
    references(config, &writer, &[], budget)?;
    let own = owner(config)?;
    if writer
        .references(&tool)
        .map_err(repository_error)?
        .iter()
        .any(|owner| owner != &own)
    {
        return Err(Error::Invalid("共享工具仍被其他发布或选择引用"));
    }
    // 同一调用方的另一个选择也不能被当前删除顺带撤销。
    let remaining = storage::all_installed(config, budget)?
        .iter()
        .filter(|value| value.module_id != id)
        .map(key)
        .collect::<Vec<_>>();
    if remaining.contains(&tool) {
        return Err(Error::Invalid("共享工具仍被其他选择引用"));
    }
    budget.check()?;
    let transaction = crate::transaction::Transaction::create(config, id, budget)?;
    let target = storage::target(config, id)?;
    let backup = transaction.path.join("backup");
    let outcome = (|| {
        fs::rename(&target, &backup).map_err(|_| Error::Io("工具选择移除暂存失败"))?;
        let removal = (|| {
            writer
                .set_references(&own, &remaining)
                .map_err(repository_error)?;
            writer
                .remove(&tool, &|| check(budget))
                .map_err(repository_error)?;
            Ok(())
        })();
        if let Err(error) = removal {
            fs::rename(&backup, &target).map_err(|_| Error::Cleanup)?;
            // 回滚恢复原引用快照，不再消费已取消的业务预算。
            let mut restored = remaining.clone();
            restored.push(tool.clone());
            writer
                .set_references(&own, &restored)
                .map_err(|_| Error::Cleanup)?;
            return Err(error);
        }
        storage::remove_tree(config, &backup)?;
        Ok(serde_json::json!({"module_id":id,"removed":true,"version":state.version}))
    })();
    transaction.finish(config, outcome)
}
