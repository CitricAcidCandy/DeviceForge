//! 绑定在准备阶段解析为真实贡献；发布锁内只合并已验证的完整快照。
use crate::{
    operation_aliases::{Config, InputMapping, ResultMapping, Target},
    registry::{Owner, Registered},
};
use apk_domain::{Error, Result};
use std::{collections::BTreeMap, sync::Arc};

pub(crate) fn prepare(
    entries: &mut BTreeMap<String, Arc<Registered>>,
    owner: &Arc<Owner>,
    config: &Config,
) -> Result<()> {
    let id = owner.info().id;
    let mut aliases = Vec::new();
    for binding in config
        .bindings
        .iter()
        .filter(|binding| binding.plugin_id() == id)
    {
        let operation = match &binding.target {
            Target::DeviceDiscovery { .. } => {
                let provider = owner
                    .provider
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("发现绑定要求设备提供者".into()))?;
                if let ResultMapping::DeviceDiscovery { platform } = &binding.result
                    && (provider.api_version != 3 || &provider.platform != platform)
                {
                    return Err(Error::Invalid("旧发现数组要求API3及相同的显式平台".into()));
                }
                &provider.discover_operation
            }
            Target::DeviceCapability {
                capability,
                version,
                ..
            } => {
                let provider = owner
                    .provider
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("能力绑定要求目标贡献提供设备声明".into()))?;
                &provider
                    .capabilities
                    .iter()
                    .find(|entry| entry.id == *capability && entry.version == *version)
                    .ok_or_else(|| Error::Invalid("绑定的设备能力精确版本不存在".into()))?
                    .operation
            }
            Target::Operation { operation, .. } => {
                if matches!(binding.input, InputMapping::DeviceEnvelope) {
                    return Err(Error::Invalid("设备封套转换只允许设备能力绑定".into()));
                }
                if owner.provider.as_ref().is_some_and(|provider| {
                    provider.discover_operation == *operation
                        || provider
                            .capabilities
                            .iter()
                            .any(|entry| entry.operation == *operation)
                }) {
                    return Err(Error::Invalid(
                        "普通操作绑定不能绕过设备能力或发现边界".into(),
                    ));
                }
                operation
            }
        };
        let target = entries
            .get(operation)
            .cloned()
            .ok_or_else(|| Error::Invalid("绑定目标必须是插件实际贡献".into()))?;
        if binding.result.requires_host_result()
            && target.executor.result_format()
                != apk_domain::ExecutorResultFormat::PublishedArtifacts
        {
            return Err(Error::Invalid(
                "结果投影要求目标通过宿主发布产物包装".into(),
            ));
        }
        if entries.contains_key(&binding.operation.id) {
            return Err(Error::Conflict("别名与实际贡献冲突".into()));
        }
        if binding.operation.execution.is_some() {
            return Err(Error::Invalid("旧别名不能声明独立执行预算".into()));
        }
        let mut public_operation = binding.operation.clone();
        public_operation.execution = target.operation.execution;
        let validator = crate::registration::compile(&public_operation)?;
        aliases.push((
            binding.operation.id.clone(),
            Arc::new(Registered {
                operation: public_operation,
                executor: target.executor.clone(),
                validator,
                owner: Some(owner.clone()),
                target: Some(target),
                binding: Some(Arc::new(binding.clone())),
            }),
        ));
    }
    if entries.len() + aliases.len() > 4096 {
        return Err(Error::TooLarge);
    }
    entries.extend(aliases);
    Ok(())
}
