//! 调试器公开传输契约；不承载脚本、工具路径或认证材料。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub type Result<T> = std::result::Result<T, DebuggerError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    NotFound,
    Capacity,
    Busy,
    InactiveSession,
    StaleTarget,
    WrongInstance,
    DuplicateReceipt,
    NotDelivered,
    ExpiredCommand,
    UnsupportedTarget,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebuggerError {
    pub code: ErrorCode,
    pub message: String,
}

impl fmt::Display for DebuggerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DebuggerError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Browser,
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgePlugin {
    pub plugin_id: String,
    #[serde(default)]
    pub generation: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeRegistration {
    #[serde(default)]
    pub plugins: Vec<BridgePlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeHeartbeat {
    pub instance_id: String,
    /// 不提供则保留目录；空数组表示撤销全部浏览器插件。
    #[serde(default)]
    pub plugins: Option<Vec<BridgePlugin>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserInstance {
    pub instance_id: String,
    pub plugins: Vec<BridgePlugin>,
    pub active_sessions: usize,
    pub idle_ttl_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugTarget {
    pub target_kind: TargetKind,
    #[serde(default)]
    pub instance_id: Option<String>,
    pub plugin_id: String,
    #[serde(default)]
    pub generation: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    pub target: DebugTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Active,
    Closed,
    Expired,
    Disconnected,
    TargetChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugSession {
    pub session_id: String,
    pub target: DebugTarget,
    pub state: SessionState,
    pub idle_ttl_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeStatus {
    pub instance_id: String,
    pub active_sessions: Vec<DebugSession>,
    pub targets: Vec<DebugTarget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DebugTool {
    Inspect,
    UiTree,
    UiQuery,
    UiDiff,
    UiAssert,
    UiAction,
    DataCatalog,
    DataRead,
    DataWrite,
    AutomationRun,
    Invoke,
    Reload,
    Report,
}

impl DebugTool {
    pub(crate) fn is_action(self) -> bool {
        matches!(
            self,
            Self::UiAction | Self::Invoke | Self::Reload | Self::DataWrite | Self::AutomationRun
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugCommandRequest {
    pub session_id: String,
    pub tool: DebugTool,
    #[serde(default = "empty_parameters")]
    pub parameters: Value,
}

fn empty_parameters() -> Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CommandState {
    Queued,
    Delivered,
    Succeeded,
    Failed,
    /// 宿主等待到期，不表示浏览器动作停止或执行失败。
    TimedOutUnconfirmed,
    CancelledUnconfirmed,
}

impl CommandState {
    pub(crate) fn terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Delivered)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugCommandReceipt {
    pub command_id: String,
    pub session_id: String,
    pub state: CommandState,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeCommand {
    pub command_id: String,
    pub session_id: String,
    pub target: DebugTarget,
    pub tool: DebugTool,
    pub parameters: Value,
    /// 期限从入队开始，排队不重启预算。
    pub remaining_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgePoll {
    pub instance_id: String,
    #[serde(default = "poll_limit")]
    pub limit: usize,
}

fn poll_limit() -> usize {
    4
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeBatch {
    pub instance_id: String,
    pub active_sessions: Vec<DebugSession>,
    pub targets: Vec<DebugTarget>,
    pub commands: Vec<BridgeCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BridgeAck {
    pub instance_id: String,
    pub command_id: String,
    pub plugin_id: String,
    #[serde(default)]
    pub generation: Option<String>,
    pub success: bool,
    /// 只接受受限 JSON；错误也通过结构化结果传递，不收任意日志正文。
    #[serde(default)]
    pub response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugCommandResult {
    pub command_id: String,
    pub session_id: String,
    pub state: CommandState,
    pub response: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    InstanceRegistered,
    InstanceDisconnected,
    SessionOpened,
    SessionTargetSelected,
    SessionEnded,
    CommandQueued,
    CommandDelivered,
    CommandFinished,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugEvent {
    pub sequence: u64,
    pub kind: EventKind,
    pub instance_id: Option<String>,
    pub session_id: Option<String>,
    pub command_id: Option<String>,
    pub session_state: Option<SessionState>,
    pub command_state: Option<CommandState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EventQuery {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub after: u64,
    #[serde(default = "event_limit")]
    pub limit: usize,
}

fn event_limit() -> usize {
    200
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EventPage {
    pub events: Vec<DebugEvent>,
    pub next_after: u64,
    pub oldest_available: u64,
    pub latest_sequence: u64,
    pub gap: bool,
    pub dropped_events: u64,
    pub retained_bytes: usize,
}
