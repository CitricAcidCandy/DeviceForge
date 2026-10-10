//! SDK 设备声明和发现消息的命名映射，不持有宿主目录或调度任务。
use apk_domain::{Error, Operation, Result, devices::*};
use apk_plugin_sdk::devices as sdk;
#[cfg(test)]
mod tests;

pub fn definition(
    id: &str,
    access: &sdk::DeviceProviderAccess,
    operations: &[Operation],
) -> Result<DeviceProviderDefinition> {
    let prefix = format!("plugin.{id}.");
    let result = DeviceProviderDefinition {
        api_version: access.api_version,
        platform: access.platform.clone(),
        discover_operation: format!("{prefix}{}", access.discover_operation),
        capabilities: access
            .capabilities
            .iter()
            .map(|cap| DeviceCapability {
                id: cap.id.clone(),
                version: cap.version,
                operation: format!("{prefix}{}", cap.operation),
                scope: match cap.scope {
                    sdk::CapabilityScope::Provider => CapabilityScope::Provider,
                    sdk::CapabilityScope::Device => CapabilityScope::Device,
                },
                access: match cap.access {
                    sdk::CapabilityAccess::Read => CapabilityAccess::Read,
                    sdk::CapabilityAccess::Write => CapabilityAccess::Write,
                },
                execution_timeout_ms: cap.execution_timeout_ms,
            })
            .collect(),
    };
    rules::definition(&result, operations)?;
    for name in std::iter::once(&result.discover_operation)
        .chain(result.capabilities.iter().map(|cap| &cap.operation))
    {
        let operation = operations
            .iter()
            .find(|op| &op.id == name)
            .expect("规则已确认引用");
        let validator = jsonschema::validator_for(&operation.input_schema)
            .map_err(|_| Error::Invalid("设备操作模式无效".into()))?;
        if name == &result.discover_operation {
            validator
                .validate(&serde_json::json!({}))
                .map_err(|_| Error::Invalid("发现操作不接受空对象".into()))?;
        }
    }
    Ok(result)
}

pub fn discovery(
    definition: &DeviceProviderDefinition,
    value: serde_json::Value,
) -> Result<serde_json::Value> {
    let items: Vec<sdk::PluginDevice> = serde_json::from_value(value)
        .map_err(|_| Error::Dependency("设备发现结果不符合公开消息".into()))?;
    let mapped: Vec<_> = items
        .iter()
        .map(|item| ProvidedDevice {
            reference: DeviceRef {
                provider_id: String::new(),
                generation: String::new(),
                local_id: item.id.clone(),
            },
            state: match item.state {
                sdk::DeviceState::Online => DeviceState::Online,
                sdk::DeviceState::Offline => DeviceState::Offline,
                sdk::DeviceState::Unauthorized => DeviceState::Unauthorized,
                sdk::DeviceState::Unknown => DeviceState::Unknown,
            },
            raw_state: item.raw_state.clone(),
            model: item.model.clone(),
            capabilities: item
                .capabilities
                .iter()
                .map(|cap| CapabilityAvailability {
                    id: cap.id.clone(),
                    version: cap.version,
                    available: cap.available,
                    reason: cap.reason.clone(),
                })
                .collect(),
        })
        .collect();
    rules::devices(definition, &mapped)
        .map_err(|_| Error::Dependency("设备发现包含无效身份、能力或超量结果".into()))?;
    serde_json::to_value(items).map_err(|_| Error::Dependency("设备发现映射失败".into()))
}
