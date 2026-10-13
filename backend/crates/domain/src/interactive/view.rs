use super::{SessionChunk, SessionCleanup, SessionOutcome};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Opening,
    Running,
    Stopping,
    Finished,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionCompletion {
    pub outcome: Option<SessionOutcome>,
    pub cleanup: SessionCleanup,
    pub process_exited: bool,
    pub sequence: Option<u64>,
    pub failure: Option<SessionFailure>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionInfo {
    pub id: String,
    pub operation: String,
    pub plugin_id: String,
    pub generation: String,
    pub status: SessionStatus,
    pub created_at: u64,
    pub output_sequence: u64,
    pub completion: Option<SessionCompletion>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionOutputPage {
    pub session: SessionInfo,
    pub chunks: Vec<SessionChunk>,
    pub next_sequence: u64,
}
