//! 配置数量、命名空间、局部模式和有限投影的纯校验。
use super::{Config, FieldSource, InputMapping, ResultMapping, Target};
use apk_domain::{Error, Result};
use serde_json::Value;
use std::collections::HashSet;

pub(super) fn validate(config: &Config) -> Result<()> {
    if !matches!(config.format_version, 1 | 2) || config.bindings.len() > 256 {
        return Err(Error::Invalid("操作绑定要求格式 1/2，最多 256 项".into()));
    }
    let mut names = HashSet::new();
    for binding in &config.bindings {
        operation_id(&binding.operation.id)?;
        let legacy_discovery = matches!(
            binding.operation.id.as_str(),
            "android.devices" | "harmony.devices"
        );
        let discovery = matches!(binding.target, Target::DeviceDiscovery { .. });
        if config.format_version == 1
            && (legacy_discovery
                || discovery
                || matches!(binding.result, ResultMapping::DeviceDiscovery { .. }))
        {
            return Err(Error::Invalid("格式1不支持设备发现绑定".into()));
        }
        if legacy_discovery {
            let expected = if binding.operation.id == "android.devices" {
                "android"
            } else {
                "harmony"
            };
            if !discovery
                || !matches!(&binding.result, ResultMapping::DeviceDiscovery { platform } if platform == expected)
            {
                return Err(Error::Invalid(
                    "旧发现名称要求显式发现目标及同平台数组投影".into(),
                ));
            }
        }
        if matches!(binding.result, ResultMapping::DeviceDiscovery { .. }) && !discovery {
            return Err(Error::Invalid("发现数组投影只允许发现目标".into()));
        }
        if binding.operation.id.starts_with("plugin.") || !names.insert(&binding.operation.id) {
            return Err(Error::Invalid("绑定名称重复或占用插件命名空间".into()));
        }
        if binding
            .operation
            .input_schema
            .get("type")
            .and_then(Value::as_str)
            != Some("object")
        {
            return Err(Error::Invalid("绑定操作必须声明对象输入模式".into()));
        }
        apk_domain::validate_local_schema(&binding.operation.input_schema)?;
        apk_domain::plugins::plugin_id(binding.plugin_id())?;
        match &binding.target {
            Target::DeviceDiscovery { .. } => {
                if !matches!(binding.input, InputMapping::Identity)
                    || !matches!(
                        binding.result,
                        ResultMapping::Identity {} | ResultMapping::DeviceDiscovery { .. }
                    )
                {
                    return Err(Error::Invalid(
                        "发现绑定只允许原输入与原结果或有限数组投影".into(),
                    ));
                }
                crate::registration::compile(&binding.operation)?
                    .validate(&serde_json::json!({}))
                    .map_err(|_| Error::Invalid("发现绑定不接受空对象".into()))?;
            }
            Target::DeviceCapability {
                capability,
                version,
                ..
            } => {
                apk_domain::identifier(capability)?;
                if capability.len() > 100 || *version == 0 {
                    return Err(Error::Invalid("目标能力最多 100 字节且版本必须非零".into()));
                }
            }
            Target::Operation {
                plugin_id,
                operation,
            } => {
                operation_id(operation)?;
                let prefix = format!("plugin.{plugin_id}.");
                if !operation.starts_with(&prefix) || operation.len() == prefix.len() {
                    return Err(Error::Invalid(
                        "绑定目标必须是该插件命名空间内的实际操作".into(),
                    ));
                }
                if matches!(binding.input, InputMapping::DeviceEnvelope) {
                    return Err(Error::Invalid("设备封套转换只用于设备能力目标".into()));
                }
            }
        }
        result(&binding.result)?;
    }
    Ok(())
}

fn operation_id(id: &str) -> Result<()> {
    apk_domain::identifier(id)?;
    if id.len() > 128
        || id.starts_with("deviceforge.")
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(Error::Invalid(
            "绑定操作 ID 最多 128 字节且不得占用宿主命名空间".into(),
        ));
    }
    Ok(())
}

pub(super) fn result(mapping: &ResultMapping) -> Result<()> {
    match mapping {
        ResultMapping::DeviceDiscovery { platform } => {
            if platform.trim().is_empty()
                || platform.len() > 100
                || platform.chars().any(char::is_control)
            {
                return Err(Error::Invalid(
                    "发现平台必须非空、最多100字节且无控制字符".into(),
                ));
            }
            Ok(())
        }
        ResultMapping::Identity {} | ResultMapping::Value { .. } => Ok(()),
        ResultMapping::Artifact { filename: name } => filename(name),
        ResultMapping::Object { fields, .. } => {
            if fields.len() > 32 {
                return Err(Error::Invalid("结果投影最多 32 个字段".into()));
            }
            let mut names = HashSet::new();
            for field in fields {
                if field.name.trim().is_empty()
                    || field.name.len() > 128
                    || field.name.chars().any(char::is_control)
                    || !names.insert(&field.name)
                {
                    return Err(Error::Invalid(
                        "投影字段名必须唯一、非空且最多 128 字节".into(),
                    ));
                }
                match &field.source {
                    FieldSource::Input { pointer: value }
                    | FieldSource::Value { pointer: value } => pointer(value)?,
                    FieldSource::Artifact { filename: name } => filename(name)?,
                }
            }
            Ok(())
        }
    }
}

pub(super) fn pointer(value: &str) -> Result<()> {
    if value.len() > 128 || (!value.is_empty() && !value.starts_with('/')) {
        return Err(Error::Invalid(
            "投影 JSON Pointer 要求空根或斜线前缀，最多 128 字节".into(),
        ));
    }
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'~' && !matches!(bytes.next(), Some(b'0' | b'1')) {
            return Err(Error::Invalid("投影 JSON Pointer 转义无效".into()));
        }
    }
    Ok(())
}

pub(super) fn filename(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 180
        || value.starts_with('.')
        || value.ends_with(['.', ' '])
        || value.chars().any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err(Error::Invalid(
            "结果产物名称必须是不含路径的文件名，最多 180 字节".into(),
        ));
    }
    Ok(())
}
