//! 协议 3 使用开放输入流通知取消，并显式确认资源清理。
use crate::Response;
use serde::{Deserialize, Serialize};

pub const COOPERATIVE_PROTOCOL_VERSION: u32 = 3;
pub const CONTROL_LIMIT: usize = 4096;
pub const REQUEST_LIMIT: usize = 512 * 1024;
pub const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    Cancelled,
    Timeout,
    TransportFailure,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommand {
    Cancel,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlFrame {
    pub protocol_version: u32,
    pub request_id: String,
    pub command: ControlCommand,
    pub reason: CancelReason,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupOutcome {
    Complete,
    Failed,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CooperativeResponse {
    pub response: Response,
    pub cleanup: CleanupOutcome,
}
