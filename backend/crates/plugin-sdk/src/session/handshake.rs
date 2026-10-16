//! 会话打开与两帧握手；固定期限的时钟起点属于运行库。
use super::{SESSION_PROTOCOL_VERSION, validation};
use crate::{
    ArtifactContext,
    context::{ReadyCommand, StartCommand},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOpenCommand {
    Open,
}

impl<'de> Deserialize<'de> for SessionOpenCommand {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        let value = String::deserialize(decoder)?;
        if value != "open" {
            return Err(serde::de::Error::custom("会话打开命令必须为 open"));
        }
        Ok(Self::Open)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionClient {
    #[serde(deserialize_with = "validation::session_id")]
    pub id: String,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionOpen {
    #[serde(deserialize_with = "validation::version")]
    pub protocol_version: u32,
    #[serde(deserialize_with = "validation::session_id")]
    pub session_id: String,
    pub command: SessionOpenCommand,
    #[serde(deserialize_with = "validation::operation")]
    pub operation: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<ArtifactContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<SessionClient>,
}

impl SessionOpen {
    pub fn new(session_id: impl Into<String>, operation: impl Into<String>, input: Value) -> Self {
        Self {
            protocol_version: SESSION_PROTOCOL_VERSION,
            session_id: session_id.into(),
            command: SessionOpenCommand::Open,
            operation: operation.into(),
            input,
            artifacts: None,
            client: None,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        validation::identity(self.protocol_version, &self.session_id)?;
        validation::valid_operation(&self.operation)?;
        if let Some(client) = &self.client {
            validation::identity(self.protocol_version, &client.id)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionReady {
    #[serde(deserialize_with = "validation::version")]
    pub protocol_version: u32,
    #[serde(deserialize_with = "validation::session_id")]
    pub session_id: String,
    pub command: ReadyCommand,
}

impl SessionReady {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            protocol_version: SESSION_PROTOCOL_VERSION,
            session_id: session_id.into(),
            command: ReadyCommand::Ready,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        validation::identity(self.protocol_version, &self.session_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStart {
    #[serde(deserialize_with = "validation::version")]
    pub protocol_version: u32,
    #[serde(deserialize_with = "validation::session_id")]
    pub session_id: String,
    pub command: StartCommand,
    #[serde(deserialize_with = "validation::remaining")]
    pub remaining_timeout_ns: u64,
}

impl SessionStart {
    pub fn new(session_id: impl Into<String>, remaining_timeout_ns: u64) -> Self {
        Self {
            protocol_version: SESSION_PROTOCOL_VERSION,
            session_id: session_id.into(),
            command: StartCommand::Start,
            remaining_timeout_ns,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        validation::identity(self.protocol_version, &self.session_id)?;
        validation::budget(self.remaining_timeout_ns)
    }
}
