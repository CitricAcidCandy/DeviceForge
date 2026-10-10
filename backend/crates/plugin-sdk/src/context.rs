//! 协议 4 的纯握手模型；时钟与本地执行上下文属于运行库。
use serde::{Deserialize, Serialize};

pub const CONTEXT_PROTOCOL_VERSION: u32 = 4;
pub const CONTEXT_FRAME_LIMIT: usize = 4096;
pub const MAX_REMAINING_TIMEOUT_NS: u64 = 3_600_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadyCommand {
    Ready,
}

impl<'de> Deserialize<'de> for ReadyCommand {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value != "ready" {
            return Err(serde::de::Error::custom("Ready 命令必须为 ready"));
        }
        Ok(Self::Ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartCommand {
    Start,
}

impl<'de> Deserialize<'de> for StartCommand {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value != "start" {
            return Err(serde::de::Error::custom("Start 命令必须为 start"));
        }
        Ok(Self::Start)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyFrame {
    #[serde(deserialize_with = "version")]
    pub protocol_version: u32,
    #[serde(deserialize_with = "request_id")]
    pub request_id: String,
    pub command: ReadyCommand,
}

impl ReadyFrame {
    pub fn new(request_id: impl Into<String>) -> Self {
        Self {
            protocol_version: CONTEXT_PROTOCOL_VERSION,
            request_id: request_id.into(),
            command: ReadyCommand::Ready,
        }
    }

    /// 字面量与反序列化应用同样的规则；关联 ID 由传输方另行核对。
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identity(self.protocol_version, &self.request_id)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartFrame {
    #[serde(deserialize_with = "version")]
    pub protocol_version: u32,
    #[serde(deserialize_with = "request_id")]
    pub request_id: String,
    pub command: StartCommand,
    #[serde(deserialize_with = "remaining")]
    pub remaining_timeout_ns: u64,
}

impl StartFrame {
    pub fn new(request_id: impl Into<String>, remaining_timeout_ns: u64) -> Self {
        Self {
            protocol_version: CONTEXT_PROTOCOL_VERSION,
            request_id: request_id.into(),
            command: StartCommand::Start,
            remaining_timeout_ns,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identity(self.protocol_version, &self.request_id)?;
        if self.remaining_timeout_ns > MAX_REMAINING_TIMEOUT_NS {
            return Err("剩余期限超过 3600000000000 纳秒");
        }
        Ok(())
    }
}

fn validate_identity(version: u32, id: &str) -> Result<(), &'static str> {
    if version != CONTEXT_PROTOCOL_VERSION {
        return Err("执行上下文要求协议 4");
    }
    if id.is_empty() || id.len() > 128 {
        return Err("请求 ID 必须为 1 至 128 字节");
    }
    Ok(())
}

fn version<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    validate_identity(value, "id").map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn request_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    validate_identity(CONTEXT_PROTOCOL_VERSION, &value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn remaining<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > MAX_REMAINING_TIMEOUT_NS {
        return Err(serde::de::Error::custom("剩余期限超过 3600000000000 纳秒"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests;
