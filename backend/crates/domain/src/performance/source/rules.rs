//! 性能源的纯注册资格；不持有注册表、设备观测或工具资源。
use super::PerformanceSourceDefinition;
use crate::{Error, Operation, Result, devices::*};
use serde_json::{Map, Value};

pub(super) fn definition(
    source: &PerformanceSourceDefinition,
    plugin_id: &str,
    operations: &[Operation],
    provider: Option<&DeviceProviderDefinition>,
) -> Result<()> {
    if !source
        .operation
        .starts_with(&format!("plugin.{plugin_id}."))
    {
        return Err(Error::Invalid("性能采样贡献不得越过自身命名空间".into()));
    }
    let operation = operations
        .iter()
        .find(|op| op.id == source.operation)
        .ok_or_else(|| Error::Invalid("性能采样贡献不存在".into()))?;
    if operation.execution.is_some() {
        return Err(Error::Invalid("性能采样贡献不得重复声明普通预算".into()));
    }
    if source.partial_metrics && source.api_version != 2 {
        return Err(Error::Invalid("部分缺测能力要求设备性能API2".into()));
    }
    match (source.api_version, &source.device_capability) {
        (1, None) => Ok(()),
        (2, Some(binding)) => {
            let provider = provider
                .filter(|provider| provider.api_version == 3)
                .ok_or_else(|| Error::Invalid("设备型性能采样要求同插件设备 API 3".into()))?;
            let capability = provider
                .capabilities
                .iter()
                .find(|cap| cap.id == binding.id && cap.version == binding.version)
                .ok_or_else(|| Error::Invalid("性能采样绑定的精确设备能力不存在".into()))?;
            if capability.operation != source.operation
                || capability.scope != CapabilityScope::Device
                || capability.access != CapabilityAccess::Read
                || binding.version == 0
            {
                return Err(Error::Invalid(
                    "性能采样必须绑定自身贡献的 device/read 能力".into(),
                ));
            }
            device_schema(&operation.input_schema)
        }
        _ => Err(Error::Invalid("性能声明版本或设备绑定无效".into())),
    }
}

fn device_schema(schema: &Value) -> Result<()> {
    let properties = object_schema(schema, &["device_id", "input"])?;
    string_schema(&properties["device_id"])?;
    let input = object_schema(&properties["input"], &["package"])?;
    string_schema(&input["package"])
}

fn object_schema<'a>(schema: &'a Value, names: &[&str]) -> Result<&'a Map<String, Value>> {
    let valid = || Error::Invalid("性能采样模式必须为严格的 device_id/input.package 封套".into());
    let object = schema.as_object().ok_or_else(valid)?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type"
                | "additionalProperties"
                | "properties"
                | "required"
                | "$schema"
                | "title"
                | "description"
        )
    }) || schema.get("type").and_then(Value::as_str) != Some("object")
        || schema.get("additionalProperties") != Some(&Value::Bool(false))
    {
        return Err(valid());
    }
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(valid)?;
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .ok_or_else(valid)?;
    if properties.len() != names.len()
        || required.len() != names.len()
        || names.iter().any(|name| {
            !properties.contains_key(*name)
                || required
                    .iter()
                    .filter(|item| item.as_str() == Some(*name))
                    .count()
                    != 1
        })
    {
        return Err(valid());
    }
    Ok(properties)
}

fn string_schema(schema: &Value) -> Result<()> {
    if schema.as_object().is_none_or(|object| {
        object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "type" | "minLength" | "maxLength" | "pattern" | "not" | "title" | "description"
            )
        })
    }) || schema.get("type").and_then(Value::as_str) != Some("string")
        || schema
            .get("not")
            .is_some_and(|value| !string_exclusion(value))
    {
        return Err(Error::Invalid(
            "性能采样设备标识和包名必须为字符串模式".into(),
        ));
    }
    Ok(())
}

// 排除模式只收窄字符串值域，不允许引用或嵌套的任意模式。
fn string_exclusion(schema: &Value) -> bool {
    let Some(object) = schema.as_object().filter(|object| object.len() == 1) else {
        return false;
    };
    if let Some(pattern) = object.get("pattern") {
        return pattern.is_string();
    }
    object
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    item.as_object().is_some_and(|object| {
                        object.len() == 1 && object.get("pattern").is_some_and(Value::is_string)
                    })
                })
        })
}
