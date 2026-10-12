//! 同一文件系统上的 staging/backup 重命名事务；提交前失败先恢复旧目录。
use crate::{
    budget::Budget,
    config::Config,
    error::{Error, Result},
    storage,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct Transaction {
    pub path: PathBuf,
}
impl Transaction {
    pub fn create(config: &Config, id: &str, budget: &Budget) -> Result<Self> {
        budget.check()?;
        let base = config.root.join(".transactions");
        storage::directory(&base)?;
        let path = base.join(id);
        match fs::create_dir(&path) {
            Ok(()) => Ok(Self { path }),
            // 进程硬终止遗留的 backup 不自动删除，交部署者核对恢复。
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(Error::Cleanup),
            Err(_) => Err(Error::Io("创建模块安装事务失败")),
        }
    }
    pub fn finish(
        self,
        config: &Config,
        outcome: Result<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        if self.path.join("backup").exists() && outcome.is_err() {
            return Err(Error::Cleanup);
        }
        storage::remove_tree(config, &self.path)?;
        outcome
    }
}
pub(crate) fn replace(target: &Path, payload: &Path, backup: &Path, budget: &Budget) -> Result<()> {
    replace_checked(target, payload, backup, &|| budget.check())
}

fn replace_checked(
    target: &Path,
    payload: &Path,
    backup: &Path,
    check: &dyn Fn() -> Result<()>,
) -> Result<()> {
    check()?;
    let had_previous = target.exists();
    if had_previous {
        fs::rename(target, backup).map_err(|_| Error::Io("备份旧模块失败"))?;
    }
    let result = check()
        .and_then(|_| fs::rename(payload, target).map_err(|_| Error::Io("提交新模块目录失败")))
        .and_then(|_| check());
    if let Err(error) = result {
        // 回滚不使用已经撤销的业务预算，避免把旧目录留在 backup 中。
        if target.exists() {
            fs::remove_dir_all(target).map_err(|_| Error::Cleanup)?;
        }
        if had_previous {
            fs::rename(backup, target).map_err(|_| Error::Cleanup)?;
        }
        return Err(error);
    }
    Ok(())
}
pub(crate) fn remove(config: &Config, id: &str, budget: &Budget) -> Result<serde_json::Value> {
    let _lock = storage::ModuleLock::acquire(config, id, budget)?;
    let Some(state) = storage::installed(config, id, budget)? else {
        return Ok(serde_json::json!({"module_id":id,"removed":false}));
    };
    let target = storage::target(config, id)?;
    let transaction = Transaction::create(config, id, budget)?;
    let backup = transaction.path.join("backup");
    let outcome = (|| {
        budget.check()?;
        fs::rename(&target, &backup).map_err(|_| Error::Io("移除模块暂存失败"))?;
        if let Err(error) = budget.check() {
            fs::rename(&backup, &target).map_err(|_| Error::Cleanup)?;
            return Err(error);
        }
        // 到此提交移除，之后只做资源收尾，不再授予或重置业务期限。
        storage::remove_tree(config, &backup)?;
        Ok(serde_json::json!({"module_id":id,"removed":true,"version":state.version}))
    })();
    transaction.finish(config, outcome)
}

#[cfg(test)]
#[path = "transaction_tests.rs"]
mod tests;
