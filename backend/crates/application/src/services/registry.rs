//! 目录派生自当前操作快照，不另建可能滞后的服务所有权表。
use crate::registry::{Registered, Registry};
use apk_domain::{Error, Executor, Result, services::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(crate) fn validate(executor: &dyn Executor) -> Result<()> {
    let access = executor.services();
    if access.provided.len() + access.required.len() > 256 {
        return Err(Error::TooLarge);
    }
    let operations = executor.operations();
    let sessions = executor
        .session_provider()
        .map(|p| p.definitions())
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    for provided in &access.provided {
        validate_ref(&provided.service)?;
        if !seen.insert(provided.service.clone()) {
            return Err(Error::Conflict("服务精确版本重复声明".into()));
        }
        let operation = operations
            .iter()
            .find(|op| op.id == provided.operation)
            .ok_or_else(|| Error::Invalid("服务必须映射已有普通操作".into()))?;
        if operation.input_schema != provided.contract.input_schema {
            return Err(Error::Invalid(
                "服务输入契约必须与映射操作输入模式一致".into(),
            ));
        }
        for schema in [
            &provided.contract.input_schema,
            &provided.contract.output_schema,
        ] {
            apk_domain::validate_local_schema(schema)?;
            jsonschema::validator_for(schema)
                .map_err(|_| Error::Invalid("服务契约模式无效".into()))?;
        }
    }
    for required in &access.required {
        validate_ref(&required.service)?;
        if required.operations.is_empty() && required.sessions.is_empty() {
            return Err(Error::Invalid("必需服务必须限定受影响入口".into()));
        }
        if required
            .operations
            .iter()
            .any(|id| !operations.iter().any(|op| &op.id == id))
            || required
                .sessions
                .iter()
                .any(|id| !sessions.iter().any(|op| &op.id == id))
        {
            return Err(Error::Invalid("必需服务指向不存在的入口".into()));
        }
    }
    Ok(())
}

pub(crate) fn validate_ref(reference: &ServiceRef) -> Result<()> {
    apk_domain::identifier(&reference.id)?;
    if reference.id.len() > 128
        || reference.version.trim().is_empty()
        || reference.version.len() > 128
        || !reference
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err(Error::Invalid("服务 ID 或精确版本无效".into()));
    }
    Ok(())
}

pub(crate) type Catalog = BTreeMap<ServiceRef, (ProvidedService, Arc<Registered>)>;
pub(crate) fn catalog(entries: &BTreeMap<String, Arc<Registered>>) -> Result<Catalog> {
    let mut result = BTreeMap::new();
    for entry in entries.values().filter(|entry| entry.target.is_none()) {
        for provided in entry
            .executor
            .services()
            .provided
            .into_iter()
            .filter(|p| p.operation == entry.operation.id)
        {
            if result
                .insert(provided.service.clone(), (provided, entry.clone()))
                .is_some()
            {
                return Err(Error::Conflict("同一服务精确版本只能有一个提供者".into()));
            }
        }
    }
    Ok(result)
}

fn available(
    catalog: &Catalog,
    reference: &ServiceRef,
    path: &mut BTreeSet<ServiceRef>,
) -> Result<()> {
    if path.len() >= 8 || !path.insert(reference.clone()) {
        return Err(Error::Conflict("服务依赖递归或深度超过 8".into()));
    }
    let (_, entry) = catalog.get(reference).ok_or_else(|| {
        Error::Conflict(format!(
            "必需服务不可用：{}@{}",
            reference.id, reference.version
        ))
    })?;
    for required in entry
        .executor
        .services()
        .required
        .iter()
        .filter(|r| r.operations.contains(&entry.operation.id))
    {
        available(catalog, &required.service, path)?;
    }
    path.remove(reference);
    Ok(())
}

impl Registry {
    pub(crate) fn service(
        &self,
        reference: &ServiceRef,
        generation: Option<&str>,
    ) -> Result<(ProvidedService, Arc<Registered>)> {
        validate_ref(reference)?;
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("服务注册读取异常".into()))?;
        let catalog = catalog(&snapshot.entries)?;
        let result = catalog
            .get(reference)
            .cloned()
            .ok_or_else(|| Error::NotFound("服务精确版本不存在".into()))?;
        if let Some(generation) = generation
            && result
                .1
                .owner
                .as_ref()
                .map(|owner| owner.info().generation)
                .unwrap_or_else(|| "builtin".into())
                != generation
        {
            return Err(Error::Conflict("服务提供者代际已变化".into()));
        }
        available(&catalog, reference, &mut BTreeSet::new())?;
        Ok(result)
    }

    pub(crate) fn check_required(
        &self,
        executor: &dyn Executor,
        operation: &str,
        session: bool,
    ) -> Result<()> {
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("服务依赖读取异常".into()))?;
        let catalog = catalog(&snapshot.entries)?;
        for required in executor.services().required {
            if (if session {
                &required.sessions
            } else {
                &required.operations
            })
            .iter()
            .any(|id| id == operation)
            {
                available(&catalog, &required.service, &mut BTreeSet::new())?;
            }
        }
        Ok(())
    }

    pub(crate) fn services(&self) -> Result<Vec<ServiceInfo>> {
        let snapshot = self
            .0
            .read()
            .map_err(|_| Error::Storage("服务目录读取异常".into()))?;
        let catalog = catalog(&snapshot.entries)?;
        Ok(catalog
            .iter()
            .map(|(reference, (provided, entry))| {
                let provider = entry
                    .owner
                    .as_ref()
                    .map(|owner| {
                        let info = owner.info();
                        ServiceProvider {
                            id: info.id,
                            version: info.version,
                            generation: info.generation,
                        }
                    })
                    .unwrap_or(ServiceProvider {
                        id: "builtin".into(),
                        version: "1".into(),
                        generation: "builtin".into(),
                    });
                let error = available(&catalog, reference, &mut BTreeSet::new()).err();
                ServiceInfo {
                    service: reference.clone(),
                    contract: provided.contract.clone(),
                    operation: provided.operation.clone(),
                    provider,
                    available: error.is_none(),
                    unavailable_reason: error.map(|e| e.to_string()),
                }
            })
            .collect())
    }
}
