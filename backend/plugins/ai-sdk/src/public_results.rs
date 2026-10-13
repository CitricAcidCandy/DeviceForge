use crate::model::TurnResult;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub provider: &'static str,
    pub sdk_version: &'static str,
    pub profile: &'static str,
    pub configured: bool,
    pub node_version: Option<String>,
    pub cli_version: Option<String>,
    pub sdk_loaded: bool,
    pub process_scope_qualified: bool,
    pub model_verified: bool,
    pub ready: bool,
    pub projects: Vec<String>,
    pub reason: Option<String>,
    pub resource_scope: &'static str,
}

#[derive(Debug, Serialize)]
pub struct SessionResult {
    pub provider: &'static str,
    pub sdk_version: &'static str,
    pub profile: &'static str,
    pub project_id: String,
    pub thread_id: String,
    pub turns: String,
    pub closed: bool,
    pub uncertain: bool,
    pub resource_scope: &'static str,
}

#[derive(Debug, Serialize)]
pub struct AssistantResult {
    #[serde(flatten)]
    pub turn: TurnResult,
    pub assistant_turns: String,
    pub stream_output: bool,
}
