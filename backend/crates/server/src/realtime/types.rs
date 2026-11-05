//! 实时能力与通知公开契约，供 HTTP、OpenAPI 及客户端共同消费。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SOCKET_PATH: &str = "/api/v2/realtime/socket.io";
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024 + 16 * 1024;
pub const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CONNECTIONS: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RealtimeCapabilities {
    pub protocol_version: u32,
    pub path: String,
    pub transports: Vec<String>,
    pub namespaces: Vec<RealtimeNamespace>,
    pub limits: RealtimeLimits,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RealtimeNamespace {
    pub name: String,
    pub local_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RealtimeLimits {
    pub connections: usize,
    pub ping_interval_ms: u64,
    pub ping_timeout_ms: u64,
    pub connect_timeout_ms: u64,
    pub resume_window_ms: u64,
    pub buffer_packets: usize,
    pub pending_bytes: usize,
    pub message_bytes: usize,
    pub frame_bytes: usize,
    pub task_coalesce_ms: u64,
    pub debugger_concurrency: usize,
}

impl Default for RealtimeCapabilities {
    fn default() -> Self {
        Self {
            protocol_version: 1,
            path: SOCKET_PATH.into(),
            transports: vec!["websocket".into()],
            namespaces: vec![
                RealtimeNamespace {
                    name: "/debugger".into(),
                    local_only: true,
                },
                RealtimeNamespace {
                    name: "/tasks".into(),
                    local_only: false,
                },
            ],
            limits: RealtimeLimits {
                connections: MAX_CONNECTIONS,
                ping_interval_ms: 25_000,
                ping_timeout_ms: 10_000,
                connect_timeout_ms: 5_000,
                resume_window_ms: 60_000,
                buffer_packets: 8,
                pending_bytes: MAX_PENDING_BYTES,
                message_bytes: MAX_MESSAGE_BYTES,
                frame_bytes: MAX_MESSAGE_BYTES,
                task_coalesce_ms: 100,
                debugger_concurrency: 4,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TasksChanged {
    /// 十进制字符串保留完整整数精度，重连后通过 reset 声明读取快照。
    pub revision: String,
    pub reset: bool,
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NamespaceAuth {
    #[serde(default)]
    pub token: Option<String>,
}
