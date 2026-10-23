//! 资源恢复的公开视图与请求，平台核对由执行器端口实现。
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Recovered,
    Blocked,
    Busy,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Confirmed,
    Blocked,
    Busy,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCheck {
    pub resource: String,
    pub status: CheckStatus,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryReport {
    pub coverage: String,
    pub inspected: u32,
    pub remaining: u32,
    pub status: RecoveryStatus,
    pub message: String,
    pub checks: Vec<RecoveryCheck>,
}
impl RecoveryReport {
    pub fn blocked(message: impl Into<String>) -> Self {
        Self {
            coverage: "plugin".into(),
            inspected: 0,
            remaining: 1,
            status: RecoveryStatus::Blocked,
            message: message.into(),
            checks: Vec::new(),
        }
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self {
            coverage: "plugin".into(),
            inspected: 0,
            remaining: 1,
            status: RecoveryStatus::Busy,
            message: message.into(),
            checks: Vec::new(),
        }
    }
    pub fn validate(&self) -> bool {
        let text = |value: &str| !value.is_empty() && value.chars().count() <= 500;
        self.coverage == "plugin"
            && text(&self.message)
            && self.checks.len() <= 64
            && self
                .checks
                .iter()
                .all(|check| text(&check.resource) && text(&check.message))
            && (self.status != RecoveryStatus::Recovered
                || (self.remaining == 0
                    && !self.checks.is_empty()
                    && self
                        .checks
                        .iter()
                        .all(|check| check.status == CheckStatus::Confirmed)))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecoveryInput {
    pub generation: String,
    #[serde(default = "empty_object")]
    pub input: Value,
}
fn empty_object() -> Value {
    serde_json::json!({})
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RecoveryView {
    pub id: String,
    pub generation: String,
    pub supported: bool,
    pub cleanup_failed: bool,
    pub recovering: bool,
    pub last_report: Option<RecoveryReport>,
}
