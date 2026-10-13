//! 会话贡献和打开请求纯校验；不启动进程或创建临时副本。
use apk_domain::{Error, OperationExecution, OperationExecutionSource, Result, interactive::*};
use apk_plugin_sdk::{Manifest, session::SESSION_PROTOCOL_VERSION};
use std::{
    collections::{BTreeMap, HashSet},
    time::Instant,
};

pub(in crate::plugins) type Validators = BTreeMap<String, jsonschema::Validator>;

pub(in crate::plugins) fn definitions(
    manifest: &Manifest,
) -> Result<(Vec<SessionDefinition>, Validators)> {
    let Some(access) = &manifest.sessions else {
        return Ok((Vec::new(), BTreeMap::new()));
    };
    if access.protocol_version != SESSION_PROTOCOL_VERSION || access.operations.is_empty() {
        return Err(Error::Invalid("会话贡献必须使用协议 5 且非空".into()));
    }
    if access.operations.len() > 4096 {
        return Err(Error::TooLarge);
    }
    let mut names = HashSet::new();
    let mut definitions = Vec::new();
    let mut validators = BTreeMap::new();
    for contribution in &access.operations {
        if !super::super::valid_name(&contribution.name)
            || !names.insert(&contribution.name)
            || manifest
                .operations
                .iter()
                .any(|normal| normal.name == contribution.name)
        {
            return Err(Error::Conflict(
                "会话贡献名无效、重复或与普通操作重名".into(),
            ));
        }
        let definition = SessionDefinition {
            id: format!("plugin.{}.{}", manifest.id, contribution.name),
            title: contribution.title.clone(),
            input_schema: contribution.input_schema.clone(),
            execution: contribution.execution.map(|budget| OperationExecution {
                api_version: budget.api_version,
                total_timeout_ms: budget.total_timeout_ms,
                source: OperationExecutionSource::Declared,
            }),
            output_retention: match access.output_retention {
                apk_plugin_sdk::session_access::SessionOutputRetention::Complete => {
                    SessionOutputRetention::Complete
                }
                apk_plugin_sdk::session_access::SessionOutputRetention::BoundedTail => {
                    SessionOutputRetention::BoundedTail
                }
            },
        };
        definition.validate(&manifest.id)?;
        let validator = jsonschema::validator_for(&definition.input_schema)
            .map_err(|_| Error::Invalid("会话输入模式无效".into()))?;
        validators.insert(definition.id.clone(), validator);
        definitions.push(definition);
    }
    Ok((definitions, validators))
}

pub(super) fn request(validators: &Validators, request: &SessionRequest) -> Result<()> {
    if request.session_id.is_empty() || request.session_id.len() > 128 {
        return Err(Error::Invalid("会话 ID 必须为 1 至 128 字节".into()));
    }
    let validator = validators
        .get(&request.operation)
        .ok_or_else(|| Error::NotFound(request.operation.clone()))?;
    if !request.input.is_object() {
        return Err(Error::Invalid("会话输入必须为对象".into()));
    }
    if !validator.is_valid(&request.input) {
        return Err(Error::Invalid("会话输入不符合贡献模式".into()));
    }
    if request
        .deadline
        .saturating_duration_since(Instant::now())
        .as_nanos()
        > u128::from(apk_plugin_sdk::context::MAX_REMAINING_TIMEOUT_NS)
    {
        return Err(Error::Invalid("会话原预算最多一小时".into()));
    }
    Ok(())
}
