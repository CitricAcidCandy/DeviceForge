//! 服务目录与反向调用端口；宿主调度、进程和公开 SDK 相互独立。
use crate::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(deny_unknown_fields)]
pub struct ServiceRef {
    pub id: String,
    #[serde(deserialize_with = "service_version")]
    #[schemars(length(min = 1, max = 128))]
    pub version: String,
}

pub fn service_version<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<String, D::Error> {
    let version = String::deserialize(decoder)?;
    if version.trim().is_empty() || version.len() > 128 {
        return Err(serde::de::Error::custom(
            "服务版本必须为非空字符串且最多 128 字节",
        ));
    }
    Ok(version)
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceContract {
    pub input_schema: Value,
    pub output_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProvidedService {
    pub service: ServiceRef,
    pub contract: ServiceContract,
    pub operation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequiredService {
    pub service: ServiceRef,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceAccess {
    #[serde(default)]
    pub provided: Vec<ProvidedService>,
    #[serde(default)]
    pub required: Vec<RequiredService>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ServiceProvider {
    pub id: String,
    pub version: String,
    pub generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ServiceInfo {
    pub service: ServiceRef,
    pub contract: ServiceContract,
    pub operation: String,
    pub provider: ServiceProvider,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ServiceCallRequest {
    #[serde(deserialize_with = "service_version")]
    #[schemars(length(min = 1, max = 128))]
    pub version: String,
    pub input: Value,
    /// 可选乐观代际约束；不指定时在本次提交时绑定当前代。
    #[serde(default)]
    pub generation: Option<String>,
}

#[async_trait]
pub trait ServiceCaller: Send + Sync {
    async fn call(
        &self,
        service: ServiceRef,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value>;
}
