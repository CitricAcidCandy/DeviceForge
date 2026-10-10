//! 注册目录中的普通操作有效预算，不包含单调时钟截止点或调度副作用。
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

pub const EXECUTION_API_VERSION: u32 = 1;
pub const DEFAULT_TOTAL_TIMEOUT_MS: u64 = 60_000;
pub const MIN_TOTAL_TIMEOUT_MS: u64 = 1;
pub const MAX_TOTAL_TIMEOUT_MS: u64 = 3_600_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationExecutionSource {
    Default,
    Declared,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationExecution {
    #[serde(deserialize_with = "version")]
    #[schemars(range(min = 1, max = 1))]
    pub api_version: u32,
    #[serde(deserialize_with = "timeout")]
    #[schemars(range(min = 1, max = 3600000))]
    pub total_timeout_ms: u64,
    pub source: OperationExecutionSource,
}

impl OperationExecution {
    /// 注册边界须校验 Rust 构造的值；不在此处判断贡献是否属于设备或性能。
    pub fn validate(&self) -> Result<()> {
        if self.api_version != EXECUTION_API_VERSION {
            return Err(Error::Invalid("普通操作预算版本必须为 1".into()));
        }
        if !(MIN_TOTAL_TIMEOUT_MS..=MAX_TOTAL_TIMEOUT_MS).contains(&self.total_timeout_ms) {
            return Err(Error::Invalid(
                "普通操作总预算必须在 1 至 3600000 毫秒之间".into(),
            ));
        }
        Ok(())
    }
}

fn version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != EXECUTION_API_VERSION {
        return Err(serde::de::Error::custom("普通操作预算版本必须为 1"));
    }
    Ok(value)
}

fn timeout<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if !(MIN_TOTAL_TIMEOUT_MS..=MAX_TOTAL_TIMEOUT_MS).contains(&value) {
        return Err(serde::de::Error::custom(
            "普通操作总预算必须在 1 至 3600000 毫秒之间",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests;
