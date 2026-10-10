//! 操作注册契约与编译门禁，服务启动和管理员安装校验共用。
use apk_domain::{Error, Operation, Result};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn compile(operation: &Operation) -> Result<jsonschema::Validator> {
    if let Some(execution) = &operation.execution {
        execution.validate()?;
    }
    apk_domain::identifier(&operation.id)?;
    if operation.id.len() > 128
        || operation.id.starts_with("deviceforge.")
        || !operation
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(Error::Invalid(
            "操作 ID 必须兼容 MCP 命名且不得占用 deviceforge 命名空间".into(),
        ));
    }
    if !operation.input_schema.is_object()
        || operation.input_schema.get("type").and_then(Value::as_str) != Some("object")
    {
        return Err(Error::Invalid("公开操作必须声明对象类型输入模式".into()));
    }
    apk_domain::validate_local_schema(&operation.input_schema)?;
    jsonschema::validator_for(&operation.input_schema)
        .map_err(|error| Error::Invalid(format!("操作模式无效：{error}")))
}

pub fn validate_operations(operations: &[Operation]) -> Result<()> {
    let mut ids = HashSet::new();
    for operation in operations {
        if !ids.insert(&operation.id) {
            return Err(Error::Conflict("操作重复注册".into()));
        }
        compile(operation)?;
    }
    Ok(())
}
