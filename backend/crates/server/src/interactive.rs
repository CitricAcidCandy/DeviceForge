use apk_domain::interactive::SessionDefinition;
use serde::{Deserialize, Serialize};

#[derive(Serialize, schemars::JsonSchema)]
pub struct SessionDefinitions {
    pub revision: u64,
    pub sessions: Vec<SessionDefinition>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionIdInput {
    pub id: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionBytesInput {
    #[schemars(length(max = 8192))]
    pub bytes: Vec<u8>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionMcpBytesInput {
    pub id: String,
    #[schemars(length(max = 8192))]
    pub bytes: Vec<u8>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionOutputInput {
    pub id: String,
    #[serde(default)]
    pub after: u64,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: usize,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct SessionReceipt {
    pub id: String,
    pub accepted: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct SessionRemoved {
    pub id: String,
}

fn default_limit() -> usize {
    50
}
