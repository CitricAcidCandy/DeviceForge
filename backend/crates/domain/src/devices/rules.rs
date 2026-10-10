//! 设备贡献与发现结果的有界规则，适配器和注册层共用。
use super::*;
use crate::{Error, Operation, Result};
use std::collections::HashSet;

pub fn text(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(Error::Invalid("设备描述必须为有界有效文字".into()));
    }
    Ok(())
}
pub fn local_id(value: &str) -> Result<()> {
    text(value, 200)?;
    if value.starts_with('-') {
        return Err(Error::Invalid("设备本地 ID 不得以连字符开头".into()));
    }
    Ok(())
}
pub fn definition(definition: &DeviceProviderDefinition, operations: &[Operation]) -> Result<()> {
    if !matches!(definition.api_version, 1..=3) || definition.capabilities.len() > 32 {
        return Err(Error::Invalid(
            "设备声明要求 API 1/2/3 且最多 32 项能力".into(),
        ));
    }
    text(&definition.platform, 100)?;
    let mut names = HashSet::new();
    let discover = operations
        .iter()
        .find(|op| op.id == definition.discover_operation)
        .ok_or_else(|| Error::Invalid("设备发现必须引用自身实际贡献".into()))?;
    if !accepts(discover, &serde_json::json!({}))? {
        return Err(Error::Invalid("发现贡献必须接受空对象".into()));
    }
    names.insert(&definition.discover_operation);
    let mut capabilities = HashSet::new();
    for capability in &definition.capabilities {
        if let Some(timeout) = capability.execution_timeout_ms
            && (!matches!(definition.api_version, 2 | 3)
                || timeout == 0
                || timeout > MAX_EXECUTION_TIMEOUT_MS)
        {
            return Err(Error::Invalid(
                "能力执行预算仅支持 API 2/3，要求 1–120000 毫秒".into(),
            ));
        }
        crate::identifier(&capability.id)?;
        if capability.id.len() > 100
            || capability.version == 0
            || !capabilities.insert((&capability.id, capability.version))
            || !names.insert(&capability.operation)
        {
            return Err(Error::Invalid("设备能力标识、版本或操作重复无效".into()));
        }
        let operation = operations
            .iter()
            .find(|op| op.id == capability.operation)
            .ok_or_else(|| Error::Invalid("设备能力必须引用自身实际贡献".into()))?;
        let sample = serde_json::json!({"device_id":if capability.scope == CapabilityScope::Device {Some("device")}else{None},"input":{}});
        // 仅检查封套形状；业务必填字段、设备 pattern/enum 由真实输入验证。
        if !accepts(operation, &sample)? {
            return Err(Error::Invalid(
                "能力贡献必须接受标准 device_id/input 对象".into(),
            ));
        }
        let properties = operation.input_schema.get("properties");
        if !field_type(properties.and_then(|p| p.get("input")), "object")
            || !field_type(
                properties.and_then(|p| p.get("device_id")),
                if capability.scope == CapabilityScope::Device {
                    "string"
                } else {
                    "null"
                },
            )
        {
            return Err(Error::Invalid("能力模式的标准封套字段类型不兼容".into()));
        }
    }
    Ok(())
}
fn field_type(schema: Option<&serde_json::Value>, expected: &str) -> bool {
    match schema.and_then(|schema| schema.get("type")) {
        None => true,
        Some(serde_json::Value::String(value)) => value == expected,
        Some(serde_json::Value::Array(values)) => {
            values.iter().any(|value| value.as_str() == Some(expected))
        }
        _ => false,
    }
}
// 领域不编译 JSON 模式；声明校验由上层传入的结构做必要形状核对。
fn accepts(operation: &Operation, sample: &serde_json::Value) -> Result<bool> {
    let schema = &operation.input_schema;
    crate::validate_local_schema(schema)?;
    if schema.get("type").and_then(serde_json::Value::as_str) != Some("object") {
        return Ok(false);
    }
    let required = schema.get("required").and_then(serde_json::Value::as_array);
    if required.is_some_and(|fields| {
        fields.iter().any(|field| {
            !sample
                .as_object()
                .unwrap()
                .contains_key(field.as_str().unwrap_or_default())
        })
    }) {
        return Ok(false);
    }
    if schema.get("additionalProperties") == Some(&serde_json::Value::Bool(false)) {
        let properties = schema
            .get("properties")
            .and_then(serde_json::Value::as_object);
        if sample
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !properties.is_some_and(|p| p.contains_key(key)))
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn devices(definition: &DeviceProviderDefinition, devices: &[ProvidedDevice]) -> Result<()> {
    if devices.len() > 128 {
        return Err(Error::TooLarge);
    }
    let mut ids = HashSet::new();
    for device in devices {
        local_id(&device.reference.local_id)?;
        if !ids.insert(&device.reference.local_id) || device.capabilities.len() > 32 {
            return Err(Error::Invalid("发现包含重复设备或过量能力".into()));
        }
        if let Some(raw_state) = &device.raw_state {
            if definition.api_version != 3 {
                return Err(Error::Invalid("原始设备状态仅支持 API 3".into()));
            }
            // len 计算 UTF-8 字节数；只校验，原文不规范化或推导归一化状态。
            text(raw_state, 100)?;
        }
        if let Some(model) = &device.model {
            text(model, 200)?;
        }
        let mut capabilities = HashSet::new();
        for capability in &device.capabilities {
            if !capabilities.insert((&capability.id, capability.version))
                || !definition.capabilities.iter().any(|declared| {
                    declared.id == capability.id
                        && declared.version == capability.version
                        && declared.scope == CapabilityScope::Device
                })
            {
                return Err(Error::Invalid("发现结果包含重复或未声明的设备能力".into()));
            }
            if let Some(reason) = &capability.reason {
                text(reason, 500)?;
            }
        }
    }
    Ok(())
}
