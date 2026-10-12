use crate::{
    budget::Budget,
    config::Config,
    error::{Error, Result},
    manifest::{LoadError, Manifest, Module},
    operations, storage,
};
use serde_json::{Value, json};

fn matching<'manifest>(manifest: &'manifest Manifest, key: &str) -> Vec<&'manifest Module> {
    manifest
        .modules
        .iter()
        .filter(|module| module.kind == "runtime" && module.feature_key.as_deref() == Some(key))
        .collect()
}

pub(crate) async fn status(
    config: &Config,
    key: &str,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    storage::check_local_stable(config, budget)?;
    let snapshot = match Manifest::load(config, client, budget).await {
        Ok(snapshot) => snapshot,
        Err(LoadError::Hard(error)) => return Err(error),
        Err(LoadError::SourceUnavailable(error)) => {
            budget.check()?;
            return Ok(json!({"feature_key":key,"manifest_version":null,
                "manifest_source":null,"manifest_sha256":null,
                "source_error":error.to_string(),"found":false,"ready":false,"modules":[]}));
        }
    };
    let selected = matching(&snapshot.manifest, key);
    let found = !selected.is_empty();
    let mut ready = found;
    let mut modules = Vec::with_capacity(selected.len());
    for module in selected {
        budget.check()?;
        let _lock = storage::ModuleLock::acquire(config, &module.name, budget)?;
        let installed = storage::installed(config, &module.name, budget)?;
        let present = installed
            .as_ref()
            .map(|state| operations::entry_present(config, state))
            .transpose()?
            .unwrap_or(false);
        let row = operations::row(module, installed.as_ref(), present)?;
        ready &= row["action"] == "current" && present;
        modules.push(row);
    }
    budget.check()?;
    Ok(snapshot.annotate(json!({"feature_key":key,"found":found,"ready":ready,"modules":modules})))
}

pub(crate) async fn prepare(
    config: &Config,
    key: &str,
    client: &reqwest::Client,
    budget: &Budget,
) -> Result<Value> {
    let snapshot = Manifest::load(config, client, budget).await?;
    let manifest = &snapshot.manifest;
    let selected = matching(manifest, key);
    if selected.is_empty() {
        return Err(Error::Invalid("清单不存在指定运行时功能"));
    }
    let mut modules = Vec::with_capacity(selected.len());
    for module in selected {
        budget.check()?;
        modules.push(
            operations::install_snapshot(
                config,
                module,
                &manifest.manifest_version,
                client,
                budget,
            )
            .await?,
        );
    }
    budget.check()?;
    Ok(snapshot.annotate(json!({"feature_key":key,"ready":true,"modules":modules})))
}
