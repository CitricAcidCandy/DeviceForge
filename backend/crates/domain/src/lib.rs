use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

mod execution;
pub use execution::ExecutionContext;
mod executor_result;
pub use executor_result::ExecutorResultFormat;
pub mod operation_execution;
pub use operation_execution::{OperationExecution, OperationExecutionSource};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("输入无效：{0}")]
    Invalid(String),
    #[error("产物大小超过上限")]
    TooLarge,
    #[error("资源不存在：{0}")]
    NotFound(String),
    #[error("操作冲突：{0}")]
    Conflict(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("执行超时")]
    Timeout,
    #[error("插件资源清理未确认，请检查外部资源后再恢复")]
    CleanupFailed,
    #[error("依赖执行失败：{0}")]
    Dependency(String),
    #[error("存储失败：{0}")]
    Storage(String),
}
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// 稳定错误类别用于公开响应和日志，不包含底层载荷或路径。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid_input",
            Self::TooLarge => "payload_too_large",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::CleanupFailed => "cleanup_failed",
            Self::Dependency(_) => "dependency_failed",
            Self::Storage(_) => "storage_failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}
impl JobStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Job {
    pub id: String,
    pub operation: String,
    pub input: Value,
    pub status: JobStatus,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct JobEvent {
    pub sequence: u64,
    pub job_id: String,
    pub status: JobStatus,
    pub timestamp: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub platform: String,
    pub state: String,
    pub model: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Operation {
    pub id: String,
    pub title: String,
    pub input_schema: Value,
    /// 普通操作在注册时固化的有效预算；设备等专用贡献不使用此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<OperationExecution>,
}
#[async_trait]
pub trait Executor: Send + Sync {
    fn operations(&self) -> Vec<Operation>;
    /// 默认不信任业务 JSON 的包装外形；仅宿主发布适配器覆盖此声明。
    fn result_format(&self) -> ExecutorResultFormat {
        ExecutorResultFormat::Json
    }
    /// 默认没有设备贡献；声明与实际操作一起注册，不按平台字符串推断。
    fn device_provider(&self) -> Option<devices::DeviceProviderDefinition> {
        None
    }
    /// 默认没有性能来源；注册层将声明与对应贡献原子发布和撤销。
    fn performance_source(&self) -> Option<performance::PerformanceSourceDefinition> {
        None
    }
    /// 默认用于无外部会话的执行器；合作插件不可确定清理后必须持续返回 true。
    fn has_unresolved_resources(&self) -> bool {
        false
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value>;
    /// 兼容已有执行器；宿主仍负责外围期限，插件传输覆盖此入口共享截止点。
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        _context: ExecutionContext,
    ) -> Result<Value> {
        self.execute(operation, input, cancel).await
    }
}
pub trait JobStore: Send + Sync {
    fn create(&self, job: &Job) -> Result<()>;
    fn get(&self, id: &str) -> Result<Job>;
    fn list(&self, limit: usize) -> Result<Vec<Job>>;
    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job>;
    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>>;
    fn recover(&self) -> Result<()>;
}
pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-[]".contains(&c))
    {
        return Err(Error::Invalid("标识符包含不支持的字符".into()));
    }
    Ok(())
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_options_and_shell_input() {
        for value in ["", "-s", "a;b", "a\nb", "$(whoami)"] {
            assert!(identifier(value).is_err());
        }
        assert!(identifier("192.168.1.10:5555").is_ok());
    }
}

pub mod artifacts;
pub mod devices;

pub mod packages;

pub mod reverse;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PluginArtifactResult {
    pub result: Value,
    pub artifacts: Vec<artifacts::Artifact>,
}

pub mod device_input;

pub mod performance;

/// 公开操作模式仅接受文档内引用，避免加载服务器文件或外部资源。
pub fn validate_local_schema(value: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            if fields
                .get("$ref")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.starts_with('#'))
                || fields.contains_key("$id")
            {
                return Err(Error::Invalid(
                    "操作模式仅支持文档内引用，禁止外部资源和 $id".into(),
                ));
            }
            for child in fields.values() {
                validate_local_schema(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_local_schema(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub mod bundles;

pub mod plugin_packages;
pub mod plugins;
pub mod splits;
