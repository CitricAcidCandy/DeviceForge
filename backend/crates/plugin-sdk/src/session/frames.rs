//! 持续输入、输出及清理终态；只定义公开数据和纯规则。
use super::{SESSION_PROTOCOL_VERSION, validation};
use crate::{
    ArtifactOutput,
    cooperative::{CancelReason, CleanupOutcome},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStream {
    Stdout,
    Stderr,
}

impl<'de> Deserialize<'de> for SessionStream {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        match String::deserialize(decoder)?.as_str() {
            "stdout" => Ok(Self::Stdout),
            "stderr" => Ok(Self::Stderr),
            _ => Err(serde::de::Error::custom(
                "会话输出路标必须为 stdout 或 stderr",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionControl {
    Input {
        #[serde(deserialize_with = "validation::version")]
        protocol_version: u32,
        #[serde(deserialize_with = "validation::session_id")]
        session_id: String,
        #[serde(deserialize_with = "validation::bytes")]
        bytes: Vec<u8>,
    },
    Eof {
        #[serde(deserialize_with = "validation::version")]
        protocol_version: u32,
        #[serde(deserialize_with = "validation::session_id")]
        session_id: String,
    },
    Cancel {
        #[serde(deserialize_with = "validation::version")]
        protocol_version: u32,
        #[serde(deserialize_with = "validation::session_id")]
        session_id: String,
        #[serde(deserialize_with = "validation::cancel_reason")]
        reason: CancelReason,
    },
}

impl SessionControl {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Input { session_id, .. }
            | Self::Eof { session_id, .. }
            | Self::Cancel { session_id, .. } => session_id,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Input {
                protocol_version,
                session_id,
                bytes,
            } => {
                validation::identity(*protocol_version, session_id)?;
                validation::chunk(bytes)
            }
            Self::Eof {
                protocol_version,
                session_id,
            }
            | Self::Cancel {
                protocol_version,
                session_id,
                ..
            } => validation::identity(*protocol_version, session_id),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "WireOutcome")]
pub struct SessionOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<ArtifactOutput>,
    pub cleanup: CleanupOutcome,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireOutcome {
    #[serde(default, deserialize_with = "crate::present_value")]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    outputs: Vec<ArtifactOutput>,
    #[serde(deserialize_with = "validation::cleanup")]
    cleanup: CleanupOutcome,
}

impl TryFrom<WireOutcome> for SessionOutcome {
    type Error = &'static str;
    fn try_from(wire: WireOutcome) -> Result<Self, Self::Error> {
        let outcome = Self {
            result: wire.result,
            error: wire.error,
            outputs: wire.outputs,
            cleanup: wire.cleanup,
        };
        outcome.validate()?;
        Ok(outcome)
    }
}

impl SessionOutcome {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.result.is_some() == self.error.is_some() {
            return Err("会话终态必须包含 result 或 error 其中之一");
        }
        if let Some(error) = &self.error {
            if error.trim().is_empty() || error.len() > 4096 {
                return Err("会话错误必须为非空且最多 4096 字节");
            }
            if !self.outputs.is_empty() {
                return Err("失败会话不得发布输出产物");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionEvent {
    Output {
        #[serde(deserialize_with = "validation::version")]
        protocol_version: u32,
        #[serde(deserialize_with = "validation::session_id")]
        session_id: String,
        #[serde(deserialize_with = "validation::sequence")]
        sequence: u64,
        stream: SessionStream,
        #[serde(deserialize_with = "validation::bytes")]
        bytes: Vec<u8>,
    },
    Finished {
        #[serde(deserialize_with = "validation::version")]
        protocol_version: u32,
        #[serde(deserialize_with = "validation::session_id")]
        session_id: String,
        #[serde(deserialize_with = "validation::sequence")]
        sequence: u64,
        outcome: SessionOutcome,
    },
}

impl SessionEvent {
    pub fn output(
        session_id: impl Into<String>,
        sequence: u64,
        stream: SessionStream,
        bytes: Vec<u8>,
    ) -> Self {
        Self::Output {
            protocol_version: SESSION_PROTOCOL_VERSION,
            session_id: session_id.into(),
            sequence,
            stream,
            bytes,
        }
    }
    pub fn finished(session_id: impl Into<String>, sequence: u64, outcome: SessionOutcome) -> Self {
        Self::Finished {
            protocol_version: SESSION_PROTOCOL_VERSION,
            session_id: session_id.into(),
            sequence,
            outcome,
        }
    }
    pub fn session_id(&self) -> &str {
        match self {
            Self::Output { session_id, .. } | Self::Finished { session_id, .. } => session_id,
        }
    }
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Output { sequence, .. } | Self::Finished { sequence, .. } => *sequence,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Output {
                protocol_version,
                session_id,
                sequence,
                bytes,
                ..
            } => {
                validation::identity(*protocol_version, session_id)?;
                validation::order(*sequence)?;
                validation::chunk(bytes)
            }
            Self::Finished {
                protocol_version,
                session_id,
                sequence,
                outcome,
            } => {
                validation::identity(*protocol_version, session_id)?;
                validation::order(*sequence)?;
                outcome.validate()
            }
        }
    }
}
