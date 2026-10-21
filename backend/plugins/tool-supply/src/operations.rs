//! 业务编排只消费固定部署配置和模块 ID，不选择服务器程序或任意路径。
use crate::{
    budget::Budget,
    config::Config,
    error::{Error, Result},
    feature,
    input::Input,
    manifest::{LoadError, Manifest, Module, compare_version},
    network,
    storage::{self, Installed},
    transaction, unpack,
};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn entry_present(config: &Config, state: &Installed) -> Result<bool> {
    let Some(entry) = &state.entry_file else {
        return Ok(true);
    };
    let path = storage::target(config, &state.module_id)?.join(unpack::relative(entry, false)?);
    Ok(storage::metadata(&path, "检查模块入口失败")?
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink()))
}
fn action(module: &Module, installed: Option<&Installed>, present: bool) -> Result<&'static str> {
    let Some(installed) = installed else {
        return Ok("install");
    };
    Ok(
        match compare_version(&module.version, &installed.version)? {
            Ordering::Greater => "update",
            Ordering::Less => "local_newer",
            Ordering::Equal
                if !present
                    || !module.sha256.eq_ignore_ascii_case(&installed.sha256)
                    || module.kind != installed.kind
                    || module.entry_file != installed.entry_file
                    || module.feature_key != installed.feature_key
                    || installed.archive_root.as_deref()
                        != Some(module.archive_root.as_deref().unwrap_or("")) =>
            {
                "repair"
            }
            Ordering::Equal => "current",
        },
    )
}
pub(crate) fn row(module: &Module, installed: Option<&Installed>, present: bool) -> Result<Value> {
    Ok(
        json!({"module_id":module.name,"kind":module.kind,"required":module.required,
        "feature_key":module.feature_key,"available_version":module.version,
        "installed_version":installed.map(|state|state.version.as_str()),"entry_present":present,
        "action":action(module,installed,present)?,"size":module.size}),
    )
}
pub(crate) async fn execute(input: Input, config: &Config, budget: &Budget) -> Result<Value> {
    if let Input::Remove(id) = &input {
        return transaction::remove(config, id, budget);
    }
    let client = network::client()?;
    match input {
        Input::Catalog => {
            let local = storage::all_installed(config, budget)?;
            let loaded = Manifest::load(config, &client, budget).await;
            let (snapshot, source_error) = match loaded {
                Ok(snapshot) => (Some(snapshot), None),
                Err(LoadError::SourceUnavailable(error)) => (None, Some(error.to_string())),
                Err(LoadError::Hard(error)) => return Err(error),
            };
            let manifest = snapshot.as_ref().map(|snapshot| &snapshot.manifest);
            let mut modules = Vec::new();
            if let Some(manifest) = &manifest {
                for module in &manifest.modules {
                    budget.check()?;
                    let installed = local.iter().find(|state| state.module_id == module.name);
                    let present = installed
                        .map(|state| entry_present(config, state))
                        .transpose()?
                        .unwrap_or(false);
                    modules.push(row(module, installed, present)?);
                }
            }
            for state in &local {
                if manifest.as_ref().is_some_and(|manifest| {
                    manifest
                        .modules
                        .iter()
                        .any(|module| module.name == state.module_id)
                }) {
                    continue;
                }
                modules.push(json!({"module_id":state.module_id,"kind":state.kind,"installed_version":state.version,
                    "available_version":null,"entry_present":entry_present(config,state)?,"action":"local_only","feature_key":state.feature_key}));
            }
            budget.check()?;
            let result = json!({"manifest_version":null,"manifest_source":null,
                "manifest_sha256":null,"source_error":source_error,"modules":modules});
            Ok(match snapshot {
                Some(snapshot) => snapshot.annotate(result),
                None => result,
            })
        }
        Input::Plan(ids) => {
            let snapshot = Manifest::load(config, &client, budget).await?;
            let manifest = &snapshot.manifest;
            let modules = if ids.is_empty() {
                manifest.modules.iter().collect::<Vec<_>>()
            } else {
                ids.iter()
                    .map(|id| manifest.module(id))
                    .collect::<Result<Vec<_>>>()?
            };
            let mut planned = Vec::new();
            let mut download_bytes = 0u64;
            for module in modules {
                budget.check()?;
                let installed = storage::installed(config, &module.name, budget)?;
                let present = installed
                    .as_ref()
                    .map(|state| entry_present(config, state))
                    .transpose()?
                    .unwrap_or(false);
                let next = row(module, installed.as_ref(), present)?;
                if matches!(
                    next["action"].as_str(),
                    Some("install" | "update" | "repair")
                ) {
                    download_bytes = download_bytes
                        .checked_add(module.size)
                        .ok_or(Error::TooLarge)?;
                }
                planned.push(next);
            }
            budget.check()?;
            Ok(snapshot.annotate(json!({"download_bytes":download_bytes,"modules":planned})))
        }
        Input::Install(id) => install(config, &id, &client, budget).await,
        Input::FeatureStatus(key) => feature::status(config, &key, &client, budget).await,
        Input::FeaturePrepare(key) => feature::prepare(config, &key, &client, budget).await,
        Input::Remove(_) => unreachable!("移除已在来源读取之前处理"),
    }
}
async fn install(
    config: &Config,
    id: &str,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    // 锁早于清单下载，使移除不能穿越整个在途安装。
    let _lock = storage::ModuleLock::acquire(config, id, budget)?;
    let snapshot = Manifest::load(config, client, budget).await?;
    let manifest = &snapshot.manifest;
    let module = manifest.module(id)?;
    let result = install_locked(config, module, &manifest.manifest_version, client, budget).await?;
    Ok(snapshot.annotate(result))
}
pub(crate) async fn install_snapshot(
    config: &Config,
    module: &Module,
    manifest_version: &str,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    let _lock = storage::ModuleLock::acquire(config, &module.name, budget)?;
    install_locked(config, module, manifest_version, client, budget).await
}
async fn install_locked(
    config: &Config,
    module: &Module,
    manifest_version: &str,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    if !requires_install(config, module, budget)? {
        return Ok(
            json!({"module_id":module.name,"version":module.version,"sha256":module.sha256,"changed":false}),
        );
    }
    let transaction = transaction::Transaction::create(config, &module.name, budget)?;
    let outcome = install_staged(
        config,
        module,
        manifest_version,
        &transaction,
        client,
        budget,
    )
    .await;
    transaction.finish(config, outcome)
}
pub(crate) fn requires_install(config: &Config, module: &Module, budget: &Budget) -> Result<bool> {
    budget.check()?;
    let id = &module.name;
    let previous = storage::installed(config, id, budget)?;
    let present = previous
        .as_ref()
        .map(|state| entry_present(config, state))
        .transpose()?
        .unwrap_or(false);
    let next = action(module, previous.as_ref(), present)?;
    if next == "local_newer" {
        return Err(Error::Invalid("拒绝自动降级已安装模块"));
    }
    Ok(next != "current")
}
async fn install_staged(
    config: &Config,
    module: &Module,
    manifest_version: &str,
    transaction: &transaction::Transaction,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    let archive = transaction.path.join("archive.zip");
    let checksum = network::archive(
        client,
        &module.url,
        config.allow_http,
        module.size,
        config.download_limit,
        &archive,
        budget,
    )
    .await?;
    if !checksum.eq_ignore_ascii_case(&module.sha256) {
        return Err(Error::Checksum);
    }
    install_archive(
        config,
        module,
        manifest_version,
        transaction,
        checksum,
        budget,
    )
    .await
}
pub(crate) async fn install_archive(
    config: &Config,
    module: &Module,
    manifest_version: &str,
    transaction: &transaction::Transaction,
    checksum: String,
    budget: &Budget,
) -> Result<Value> {
    let archive = transaction.path.join("archive.zip");
    let content = transaction.path.join("content");
    let worker_budget = budget.clone();
    let worker_archive = archive.clone();
    let worker_content = content.clone();
    let limit = config.extracted_limit;
    let files = config.file_limit;
    // 始终等待阻塞工作实际结束，取消时不遗留仍写 staging 的后台任务。
    tokio::task::spawn_blocking(move || {
        unpack::extract(
            &worker_archive,
            &worker_content,
            limit,
            files,
            &worker_budget,
        )
    })
    .await
    .map_err(|_| Error::Dependency("解压工作失败"))??;
    budget.check()?;
    let payload = content.join(unpack::relative(
        module.archive_root.as_deref().unwrap_or(""),
        true,
    )?);
    let metadata =
        fs::symlink_metadata(&payload).map_err(|_| Error::Invalid("归档缺少配置的 archiveRoot"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("归档根必须是普通目录"));
    }
    if let Some(entry) = &module.entry_file {
        let entry = payload.join(unpack::relative(entry, false)?);
        if !fs::symlink_metadata(entry)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        {
            return Err(Error::Invalid("归档缺少清单声明的入口文件"));
        }
    }
    let state = Installed {
        module_id: module.name.clone(),
        version: module.version.clone(),
        sha256: checksum,
        manifest_version: manifest_version.into(),
        installed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Dependency("系统时间无效"))?
            .as_millis()
            .try_into()
            .map_err(|_| Error::TooLarge)?,
        kind: module.kind.clone(),
        entry_file: module.entry_file.clone(),
        feature_key: module.feature_key.clone(),
        archive_root: Some(module.archive_root.clone().unwrap_or_default()),
    };
    storage::write_state(&payload, &state, budget)?;
    let target = storage::target(config, &module.name)?;
    transaction::replace(&target, &payload, &transaction.path.join("backup"), budget)?;
    Ok(
        json!({"module_id":module.name,"version":module.version,"sha256":state.sha256,"changed":true}),
    )
}
