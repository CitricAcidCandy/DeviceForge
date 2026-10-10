//! 普通操作的显式总预算；默认策略由宿主注册层决定。
use serde::{Deserialize, Serialize};

pub const EXECUTION_API_VERSION: u32 = 1;
pub const MIN_TOTAL_TIMEOUT_MS: u64 = 1;
pub const MAX_TOTAL_TIMEOUT_MS: u64 = 3_600_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionBudget {
    #[serde(deserialize_with = "version")]
    pub api_version: u32,
    #[serde(deserialize_with = "timeout")]
    pub total_timeout_ms: u64,
}

impl ExecutionBudget {
    /// Rust 字面量也须校验；反序列化时已应用相同边界。
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.api_version != EXECUTION_API_VERSION {
            return Err("普通操作预算版本必须为 1");
        }
        if !(MIN_TOTAL_TIMEOUT_MS..=MAX_TOTAL_TIMEOUT_MS).contains(&self.total_timeout_ms) {
            return Err("普通操作总预算必须在 1 至 3600000 毫秒之间");
        }
        Ok(())
    }
}

fn version<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != EXECUTION_API_VERSION {
        return Err(serde::de::Error::custom("普通操作预算版本必须为 1"));
    }
    Ok(value)
}

fn timeout<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
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
