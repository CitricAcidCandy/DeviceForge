//! 注册与任务准入规则，操作声明决定范围和读写，业务输入不能覆盖。
use crate::registry::{Owner, Registered};
use apk_domain::{Error, Operation, Result, devices::*};
use serde::Deserialize;
use serde_json::Value;

pub(crate) fn definition(
    definition: &DeviceProviderDefinition,
    operations: &[Operation],
    id: &str,
) -> Result<()> {
    rules::definition(definition, operations)?;
    let prefix = format!("plugin.{id}.");
    if !definition.discover_operation.starts_with(&prefix)
        || definition
            .capabilities
            .iter()
            .any(|cap| !cap.operation.starts_with(&prefix))
    {
        return Err(Error::Invalid("设备贡献不得越过自身命名空间".into()));
    }
    for operation in std::iter::once(&definition.discover_operation)
        .chain(definition.capabilities.iter().map(|cap| &cap.operation))
    {
        let entry = operations
            .iter()
            .find(|entry| &entry.id == operation)
            .expect("声明引用已验证");
        let validator = crate::registration::compile(entry)?;
        // 能力业务参数和设备 ID 的限制只在真实提交时验证。
        if operation == &definition.discover_operation {
            validator
                .validate(&serde_json::json!({}))
                .map_err(|_| Error::Invalid("发现贡献不接受空对象".into()))?;
        }
    }
    Ok(())
}
pub(crate) fn provider(owner: &Owner) -> Option<DeviceProviderInfo> {
    let info = owner.info();
    if info.state != apk_domain::plugins::PluginState::Loaded {
        return None;
    }
    owner.provider.clone().map(|definition| DeviceProviderInfo {
        id: info.id,
        generation: info.generation,
        version: info.version,
        definition,
    })
}

/// 声明快照和父期限决定唯一截止点，不重新查询提供者或延长刷新预算。
pub(crate) fn execution_deadline(
    registered: &Registered,
    capability: Option<&DeviceCapability>,
    admitted_at: tokio::time::Instant,
    inherited: Option<tokio::time::Instant>,
) -> Option<tokio::time::Instant> {
    let budget = capability
        .map(DeviceCapability::execution_timeout)
        .or_else(|| {
            registered.owner.as_ref().and_then(|owner| {
                owner
                    .provider
                    .as_ref()
                    .filter(|provider| provider.discover_operation == registered.operation.id)
                    .map(|_| std::time::Duration::from_millis(DEFAULT_EXECUTION_TIMEOUT_MS))
            })
        });
    match (budget.map(|budget| admitted_at + budget), inherited) {
        (Some(own), Some(parent)) => Some(own.min(parent)),
        (own, parent) => own.or(parent),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Envelope {
    pub device_id: Option<String>,
    pub input: Value,
}
pub(crate) fn envelope(value: &Value, scope: &CapabilityScope) -> Result<Envelope> {
    // Option 的缺失不能隐式变成 null；固定封套必须显式包含两个字段。
    if value.get("device_id").is_none() || value.get("input").is_none() {
        return Err(Error::Invalid("设备能力输入要求 device_id 和 input".into()));
    }
    let input: Envelope = serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("设备能力封套无效".into()))?;
    if !input.input.is_object() {
        return Err(Error::Invalid("设备业务 input 必须为对象".into()));
    }
    match (scope, &input.device_id) {
        (CapabilityScope::Provider, None) => {}
        (CapabilityScope::Device, Some(id)) => rules::local_id(id)?,
        _ => return Err(Error::Invalid("设备能力范围与 device_id 不一致".into())),
    }
    Ok(input)
}
impl crate::registry::Registry {
    pub fn device_admission(
        &self,
        registered: &Registered,
        input: &Value,
    ) -> Result<Option<(String, Option<String>, DeviceCapability)>> {
        let Some(owner) = &registered.owner else {
            return Ok(None);
        };
        if owner.info().cleanup_failed {
            return Err(Error::Conflict("插件资源清理未确认".into()));
        }
        let Some(provider) = provider(owner) else {
            return Ok(None);
        };
        if registered.operation.id == provider.definition.discover_operation {
            if input != &serde_json::json!({}) {
                return Err(Error::Invalid("发现操作只接受空对象".into()));
            }
            return Ok(None);
        }
        let Some(capability) = provider
            .definition
            .capabilities
            .iter()
            .find(|cap| cap.operation == registered.operation.id)
            .cloned()
        else {
            return Ok(None);
        };
        let envelope = envelope(input, &capability.scope)?;
        if let Some(id) = &envelope.device_id {
            let snapshot = self
                .0
                .read()
                .map_err(|_| Error::Storage("设备目录读取异常".into()))?;
            let directory = snapshot
                .directories
                .get(&provider.id)
                .filter(|dir| dir.provider.generation == provider.generation)
                .ok_or_else(|| Error::Conflict("当前代设备尚未成功观测".into()))?;
            let device = directory
                .devices
                .iter()
                .find(|device| &device.reference.local_id == id)
                .ok_or_else(|| Error::NotFound("设备不存在".into()))?;
            if device.state != DeviceState::Online
                || !device.capabilities.iter().any(|cap| {
                    cap.id == capability.id && cap.version == capability.version && cap.available
                })
            {
                return Err(Error::Conflict("设备离线或能力当前不可用".into()));
            }
        }
        Ok(Some((provider.id, envelope.device_id, capability)))
    }
}
