//! 清单中的独立会话贡献；普通任务协议与会话协议分别声明。
use crate::{Contribution, session::SESSION_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAccess {
    #[serde(deserialize_with = "version")]
    pub protocol_version: u32,
    pub operations: Vec<Contribution>,
}

impl SessionAccess {
    /// 清单字面量和反序列化后的值共用纯规则；完整模式编译由宿主完成。
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version != SESSION_PROTOCOL_VERSION {
            return Err("会话贡献要求协议版本 5");
        }
        if self.operations.is_empty() {
            return Err("会话声明必须至少贡献一个操作");
        }
        let mut names = HashSet::new();
        for operation in &self.operations {
            if operation.name.is_empty()
                || operation.name.len() >= 100
                || !operation.name.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
            {
                return Err("会话操作名必须为小写字母、数字及 ._-，且少于 100 字节");
            }
            if !names.insert(&operation.name) {
                return Err("会话操作名重复");
            }
            if !operation.input_schema.is_object()
                || operation
                    .input_schema
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    != Some("object")
            {
                return Err("公开会话必须声明对象类型输入模式");
            }
            if let Some(execution) = &operation.execution {
                execution.validate()?;
            }
        }
        Ok(())
    }
}

fn version<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(decoder)?;
    if value != SESSION_PROTOCOL_VERSION {
        return Err(serde::de::Error::custom("会话贡献要求协议版本 5"));
    }
    Ok(value)
}
