//! 旧输入保留在任务中，执行计划仅转换输入和最终结果，不创建第二份任务。
use crate::{operation_aliases, registry::Registered};
use apk_domain::{Error, Result};
use serde_json::Value;
use std::sync::Arc;

pub(crate) struct Plan {
    pub target: Arc<Registered>,
    pub input: Value,
    original: Value,
    result: Option<operation_aliases::ResultMapping>,
}
impl Plan {
    pub fn new(registered: &Arc<Registered>, original: &Value) -> Result<Self> {
        let target = registered
            .target
            .clone()
            .unwrap_or_else(|| registered.clone());
        let input = match &registered.binding {
            Some(binding) => {
                let scope = target
                    .owner
                    .as_ref()
                    .and_then(|owner| owner.provider.as_ref())
                    .and_then(|provider| {
                        provider
                            .capabilities
                            .iter()
                            .find(|cap| cap.operation == target.operation.id)
                    })
                    .map(|cap| &cap.scope);
                operation_aliases::map_input(&binding.input, original, scope)?
            }
            None => original.clone(),
        };
        if registered.binding.is_some() {
            target
                .validator
                .validate(&input)
                .map_err(|error| Error::Invalid(format!("目标输入不符合模式：{error}")))?;
        }
        Ok(Self {
            target,
            input,
            // 普通操作已经验证过输入，也不使用旧输入投影，避免重复校验和保存副本。
            original: if registered.binding.is_some() {
                original.clone()
            } else {
                Value::Null
            },
            result: registered
                .binding
                .as_ref()
                .map(|binding| binding.result.clone()),
        })
    }
    pub fn result(&self, value: Value) -> Result<Value> {
        match &self.result {
            Some(mapping) => operation_aliases::map_result(mapping, &self.original, value),
            None => Ok(value),
        }
    }
    pub fn discovery_platform(&self) -> Option<&str> {
        match &self.result {
            Some(operation_aliases::ResultMapping::DeviceDiscovery { platform }) => Some(platform),
            _ => None,
        }
    }
}
