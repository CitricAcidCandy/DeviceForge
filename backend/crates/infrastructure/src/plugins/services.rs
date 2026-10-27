//! 公开清单映射到领域声明；普通操作及独立会话短名只在此补命名空间。
use apk_domain::{Error, Result, services::*};
use apk_plugin_sdk::Manifest;

pub(super) fn definition(manifest: &Manifest) -> Result<ServiceAccess> {
    let Some(access) = &manifest.services else {
        return Ok(Default::default());
    };
    if access.provided.len() + access.required.len() > 256 {
        return Err(Error::TooLarge);
    }
    let mut references = std::collections::BTreeSet::new();
    for provided in &access.provided {
        provided
            .service
            .validate()
            .map_err(|e| Error::Invalid(e.into()))?;
        if !references.insert(provided.service.clone()) {
            return Err(Error::Conflict("服务精确版本重复声明".into()));
        }
        let operation = manifest
            .operations
            .iter()
            .find(|entry| entry.name == provided.operation)
            .ok_or_else(|| Error::Invalid("服务必须映射已有普通操作".into()))?;
        if provided.contract.input_schema != operation.input_schema {
            return Err(Error::Invalid("服务输入契约须与操作模式一致".into()));
        }
        for schema in [
            &provided.contract.input_schema,
            &provided.contract.output_schema,
        ] {
            apk_domain::validate_local_schema(schema)?;
            jsonschema::validator_for(schema)
                .map_err(|_| Error::Invalid("服务契约模式无效".into()))?;
        }
    }
    for required in &access.required {
        required
            .service
            .validate()
            .map_err(|e| Error::Invalid(e.into()))?;
    }
    let prefix = format!("plugin.{}.", manifest.id);
    let mut value: ServiceAccess = serde_json::from_value(
        serde_json::to_value(access).map_err(|_| Error::Invalid("服务声明编码失败".into()))?,
    )
    .map_err(|_| Error::Invalid("服务声明无效".into()))?;
    for provided in &mut value.provided {
        if !manifest
            .operations
            .iter()
            .any(|operation| operation.name == provided.operation)
        {
            return Err(Error::Invalid("服务必须映射本插件已有 operation".into()));
        }
        provided.operation = format!("{prefix}{}", provided.operation);
    }
    for required in &mut value.required {
        if required.operations.is_empty() && required.sessions.is_empty() {
            return Err(Error::Invalid("必需服务必须限定受影响入口".into()));
        }
        for operation in &mut required.operations {
            if !manifest
                .operations
                .iter()
                .any(|entry| entry.name == *operation)
            {
                return Err(Error::Invalid("服务依赖指向未知操作".into()));
            }
            *operation = format!("{prefix}{operation}");
        }
        for session in &mut required.sessions {
            if !manifest.sessions.as_ref().is_some_and(|sessions| {
                sessions
                    .operations
                    .iter()
                    .any(|entry| entry.name == *session)
            }) {
                return Err(Error::Invalid("服务依赖指向未知会话".into()));
            }
            *session = format!("{prefix}{session}");
        }
    }
    Ok(value)
}

pub(super) struct Unavailable;
#[async_trait::async_trait]
impl ServiceCaller for Unavailable {
    async fn call(
        &self,
        _: ServiceRef,
        _: serde_json::Value,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<serde_json::Value> {
        Err(Error::Conflict("此调用入口未配置宿主服务上下文".into()))
    }
}
