//! 发现消息来源、完整目录候选与有限旧数组投影的纯处理。
use crate::{alias_plan::Plan, registry::Registered};
use apk_domain::{Error, ExecutorResultFormat, Result, devices::*};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    id: String,
    state: DeviceState,
    model: Option<String>,
    #[serde(default)]
    raw_state: Option<String>,
    capabilities: Vec<CapabilityAvailability>,
}
pub(crate) fn candidate(
    provider: &DeviceProviderInfo,
    registered: &Registered,
    job_id: &str,
    output: Value,
    plan: &Plan,
) -> Result<(Value, DeviceDirectory)> {
    let value = match registered.executor.result_format() {
        ExecutorResultFormat::Json => {
            if !output.is_array() {
                return Err(Error::Dependency("发现裸结果必须为数组".into()));
            }
            output.clone()
        }
        ExecutorResultFormat::PublishedArtifacts => {
            let fields = output
                .as_object()
                .ok_or_else(|| Error::Dependency("缺少真实宿主发现包装".into()))?;
            if fields.len() != 2
                || !fields.contains_key("result")
                || !fields.contains_key("artifacts")
            {
                return Err(Error::Dependency("发现宿主包装结构无效".into()));
            }
            let host: apk_domain::PluginArtifactResult = serde_json::from_value(output.clone())
                .map_err(|_| Error::Dependency("发现宿主产物包装无效".into()))?;
            host.result
        }
    };
    let items: Vec<Observed> =
        serde_json::from_value(value).map_err(|_| Error::Dependency("设备发现消息无效".into()))?;
    let devices: Vec<_> = items
        .into_iter()
        .map(|item| ProvidedDevice {
            reference: DeviceRef {
                provider_id: provider.id.clone(),
                generation: provider.generation.clone(),
                local_id: item.id,
            },
            state: item.state,
            model: item.model,
            raw_state: item.raw_state,
            capabilities: item.capabilities,
        })
        .collect();
    rules::devices(&provider.definition, &devices)
        .map_err(|_| Error::Dependency("发现版本、身份、原文、能力或数量无效".into()))?;
    let projected = if let Some(platform) = plan.discovery_platform() {
        if provider.definition.api_version != 3 || platform != provider.definition.platform {
            return Err(Error::Dependency("旧发现数组要求API3与相同平台".into()));
        }
        let mut legacy = Vec::with_capacity(devices.len());
        for device in &devices {
            let raw = device
                .raw_state
                .as_ref()
                .ok_or_else(|| Error::Dependency("旧发现数组缺少同次原始状态".into()))?;
            legacy.push(json!({"id":device.reference.local_id,"platform":platform,"state":raw,"model":device.model}));
        }
        Value::Array(legacy)
    } else {
        plan.result(output)?
    };
    Ok((
        projected,
        DeviceDirectory {
            provider: provider.clone(),
            observed_at: apk_domain::now(),
            discovery_job_id: job_id.into(),
            devices,
        },
    ))
}
