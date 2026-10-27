//! 公共服务声明与协议 6 独立帧；不包含宿主调度或时钟。
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVICE_PROTOCOL_VERSION: u32 = 6;
pub const SERVICE_DEPTH_LIMIT: usize = 8;
pub const SERVICE_CONCURRENCY_LIMIT: usize = 4;
pub const FRAME_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceRef {
    pub id: String,
    #[serde(deserialize_with = "service_version")]
    pub version: String,
}

impl ServiceRef {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
            || self.version.trim().is_empty()
            || self.version.len() > 128
        {
            return Err("服务 ID 或字符串版本无效");
        }
        Ok(())
    }
}

pub fn service_version<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let version = String::deserialize(decoder)?;
    if version.trim().is_empty() || version.len() > 128 {
        return Err(serde::de::Error::custom(
            "服务版本必须为非空字符串且最多 128 字节",
        ));
    }
    Ok(version)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceContract {
    pub input_schema: Value,
    pub output_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvidedService {
    pub service: ServiceRef,
    pub contract: ServiceContract,
    /// 映射本插件已有的普通操作短名，不另建常驻进程。
    pub operation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiredService {
    pub service: ServiceRef,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceAccess {
    #[serde(default)]
    pub provided: Vec<ProvidedService>,
    #[serde(default)]
    pub required: Vec<RequiredService>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceFailure {
    pub code: String,
    pub message: String,
}

/// 协议 6 不复用协议 4 的严格版本反序列化器。
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceFrame {
    Ready {
        protocol_version: u32,
        request_id: String,
    },
    Start {
        protocol_version: u32,
        request_id: String,
        remaining_timeout_ns: u64,
    },
    Cancel {
        protocol_version: u32,
        request_id: String,
    },
    ServiceCall {
        protocol_version: u32,
        request_id: String,
        call_id: String,
        service: ServiceRef,
        input: Value,
    },
    ServiceResult {
        protocol_version: u32,
        request_id: String,
        call_id: String,
        outcome: ServiceOutcome,
    },
    ServiceCancel {
        protocol_version: u32,
        request_id: String,
        call_id: String,
    },
    Finished {
        protocol_version: u32,
        request_id: String,
        execution: crate::cooperative::CooperativeResponse,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceOutcome {
    Succeeded { result: Value },
    Failed { error: ServiceFailure },
}

impl ServiceFrame {
    pub fn validate(&self, expected: &str) -> Result<(), &'static str> {
        let (version, id, call) = match self {
            Self::Ready {
                protocol_version,
                request_id,
            }
            | Self::Start {
                protocol_version,
                request_id,
                ..
            }
            | Self::Cancel {
                protocol_version,
                request_id,
            }
            | Self::Finished {
                protocol_version,
                request_id,
                ..
            } => (*protocol_version, request_id, None),
            Self::ServiceCall {
                protocol_version,
                request_id,
                call_id,
                ..
            }
            | Self::ServiceResult {
                protocol_version,
                request_id,
                call_id,
                ..
            }
            | Self::ServiceCancel {
                protocol_version,
                request_id,
                call_id,
            } => (*protocol_version, request_id, Some(call_id)),
        };
        if version != SERVICE_PROTOCOL_VERSION
            || id != expected
            || id.is_empty()
            || id.len() > 128
            || call.is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err("协议 6 版本、请求或子调用身份无效");
        }
        if let Self::Start {
            remaining_timeout_ns,
            ..
        } = self
            && *remaining_timeout_ns > crate::context::MAX_REMAINING_TIMEOUT_NS
        {
            return Err("协议 6 剩余预算超过一小时");
        }
        if let Self::ServiceCall { service, .. } = self {
            service.validate()?;
        }
        Ok(())
    }
}
