//! 性能声明的协议关联、领域映射和采样产物权限；不运行采样或创建会话。
use apk_domain::{Error, Operation, Result, devices::DeviceProviderDefinition, performance::*};
use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, Manifest, context::CONTEXT_PROTOCOL_VERSION};

pub(super) fn definition(
    manifest: &Manifest,
    operations: &[Operation],
    devices: Option<&DeviceProviderDefinition>,
) -> Result<Option<PerformanceSourceDefinition>> {
    let Some(access) = &manifest.performance else {
        return Ok(None);
    };
    access
        .validate()
        .map_err(|message| Error::Invalid(message.into()))?;
    match access.api_version {
        1 if manifest.protocol_version == ARTIFACT_PROTOCOL_VERSION => {
            if manifest.artifacts.as_ref().is_some_and(|artifacts| {
                !artifacts.input_fields.is_empty()
                    || !artifacts.input_pointers.is_empty()
                    || artifacts.outputs
            }) {
                return Err(Error::Invalid("性能 API 1 插件不能声明产物读写能力".into()));
            }
        }
        2 if manifest.protocol_version == CONTEXT_PROTOCOL_VERSION => {
            validate_selectors(manifest)?;
        }
        _ => {
            return Err(Error::Invalid(
                "性能 API 1 要求协议 2，API 2 要求协议 4".into(),
            ));
        }
    }
    let source = PerformanceSourceDefinition {
        api_version: access.api_version,
        operation: format!("plugin.{}.{}", manifest.id, access.sample_operation),
        fps: access.fps,
        device_observation: access.device_observation,
        device_capability: access.device_capability.as_ref().map(|binding| {
            PerformanceDeviceCapability {
                id: binding.id.clone(),
                version: binding.version,
            }
        }),
    };
    source.validate(&manifest.id, operations, devices)?;
    Ok(Some(source))
}

fn validate_selectors(manifest: &Manifest) -> Result<()> {
    let Some(artifacts) = &manifest.artifacts else {
        return Ok(());
    };
    let overlaps = artifacts
        .input_fields
        .iter()
        .any(|field| matches!(field.as_str(), "device_id" | "input"))
        || artifacts.input_pointers.iter().any(|pointer| {
            // 产物公共规则已验证 Pointer；这里只判断严格采样封套的可达前缀。
            let mut tokens = pointer[1..]
                .split('/')
                .map(|token| token.replace("~1", "/").replace("~0", "~"));
            match tokens.next().as_deref() {
                Some("device_id") => true,
                Some("input") => matches!(tokens.next().as_deref(), None | Some("package")),
                _ => false,
            }
        });
    if overlaps {
        return Err(Error::Invalid(
            "产物选择器不得选择或穿过性能采样输入".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
