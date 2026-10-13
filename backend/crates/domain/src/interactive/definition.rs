//! 会话打开参数的模式与命名规则；后续原字节输入不受对象模式约束。
use super::{SESSION_CHUNK_LIMIT, SESSION_PROTOCOL_VERSION};
use crate::{Error, OperationExecution, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 声明决定输出保存语义，宿主不按具体插件名称推断持续媒体能力。
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutputRetention {
    #[default]
    Complete,
    BoundedTail,
}

impl SessionOutputRetention {
    pub fn is_complete(&self) -> bool {
        *self == Self::Complete
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionDefinition {
    pub id: String,
    pub title: String,
    pub input_schema: Value,
    /// 复用已有总预算数据；注册会话时固化，不进入普通任务调度。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<OperationExecution>,
    #[serde(default, skip_serializing_if = "SessionOutputRetention::is_complete")]
    pub output_retention: SessionOutputRetention,
}

impl SessionDefinition {
    /// 同时验证自定义提供者和进程适配器；完整 JSON 模式编译由注册层负责。
    pub fn validate(&self, plugin_id: &str) -> Result<()> {
        crate::plugins::plugin_id(plugin_id)?;
        let prefix = format!("plugin.{plugin_id}.");
        let name = self
            .id
            .strip_prefix(&prefix)
            .ok_or_else(|| Error::Invalid("会话贡献不得越过自己的插件命名空间".into()))?;
        if self.id.len() > 128
            || name.is_empty()
            || name.len() >= 100
            || !name.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            })
        {
            return Err(Error::Invalid("会话操作 ID 或局部名称无效".into()));
        }
        if !self.input_schema.is_object()
            || self.input_schema.get("type").and_then(Value::as_str) != Some("object")
        {
            return Err(Error::Invalid("公开会话必须声明对象类型输入模式".into()));
        }
        crate::validate_local_schema(&self.input_schema)?;
        if let Some(execution) = &self.execution {
            execution.validate()?;
        }
        Ok(())
    }

    /// 所有本端口会话统一使用第五版双向原字节协议。
    pub const fn protocol_version(&self) -> u32 {
        SESSION_PROTOCOL_VERSION
    }

    /// 单块限额为公开协议固有能力，不表示终端或伪终端能力。
    pub const fn chunk_limit(&self) -> usize {
        SESSION_CHUNK_LIMIT
    }
}
