//! 会话归属、输出和终态；终态明确区分插件清理报告与宿主确认。
use crate::{Error, artifacts::Artifact};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Instant};

/// 截止点覆盖打开、握手和业务阶段；传输与清理宽限由宿主另行监督。
#[derive(Clone, Debug)]
pub struct SessionRequest {
    pub session_id: String,
    pub operation: String,
    pub input: Value,
    pub client: Option<SessionClient>,
    pub deadline: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionClient {
    pub id: String,
    pub is_local: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStream {
    Stdout,
    Stderr,
}

/// 两路输出共享插件终态之前的真实序号；适配器不得重排或重编号。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionChunk {
    pub sequence: u64,
    pub stream: SessionStream,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionCleanup {
    /// 匹配终态明确报告完成，并已确认直接进程成功退出。
    Complete,
    /// 匹配且有效的插件终态明确报告清理失败。
    Failed,
    /// 缺失或错误终态、强制终止、非零退出及监督丢弃均不能确认。
    Unconfirmed,
}

/// 已验证的插件结果；artifacts 只能包含宿主已发布的产物元数据。
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionOutcome {
    pub result: Option<Value>,
    pub error: Option<String>,
    pub artifacts: Vec<Artifact>,
}

/// 后台监督的缓存结论；业务失败与清理失败不能相互覆盖。
#[derive(Clone, Debug)]
pub struct SessionExit {
    pub outcome: Option<SessionOutcome>,
    pub cleanup: SessionCleanup,
    /// 仅表示直接进程已确认退出，不证明派生进程或远端资源已释放。
    pub process_exited: bool,
    /// 仅匹配有效 Finished 时存在；取消丢弃输出后不能猜测终态序号。
    pub sequence: Option<u64>,
    /// 保留首次宿主失败，未确认清理通过 cleanup 另行表达。
    pub failure: Option<Arc<Error>>,
}
