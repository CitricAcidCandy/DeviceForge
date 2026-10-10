//! 普通预算声明的关联校验与领域映射，不填充宿主默认预算。
use apk_domain::{Error, Operation, OperationExecution, OperationExecutionSource, Result};
use apk_plugin_sdk::Manifest;

pub(super) fn validate(manifest: &Manifest) -> Result<()> {
    for contribution in &manifest.operations {
        let Some(budget) = &contribution.execution else {
            continue;
        };
        budget
            .validate()
            .map_err(|message| Error::Invalid(message.into()))?;
        let device_operation = manifest.devices.as_ref().is_some_and(|devices| {
            devices.discover_operation == contribution.name
                || devices
                    .capabilities
                    .iter()
                    .any(|capability| capability.operation == contribution.name)
        });
        let sample_operation = manifest
            .performance
            .as_ref()
            .is_some_and(|performance| performance.sample_operation == contribution.name);
        if device_operation || sample_operation {
            return Err(Error::Invalid(
                "设备发现、设备能力或性能采样操作不得重复声明普通总预算".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn operations(manifest: &Manifest) -> Vec<Operation> {
    manifest
        .operations
        .iter()
        .map(|contribution| Operation {
            id: format!("plugin.{}.{}", manifest.id, contribution.name),
            title: contribution.title.clone(),
            input_schema: contribution.input_schema.clone(),
            execution: contribution.execution.map(|budget| OperationExecution {
                api_version: budget.api_version,
                total_timeout_ms: budget.total_timeout_ms,
                source: OperationExecutionSource::Declared,
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests;
