//! 可选的资源恢复声明与有界结果，独立于普通业务任务。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryAccess {
    pub api_version: u32,
    pub operation: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Recovered,
    Blocked,
    Busy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Confirmed,
    Blocked,
    Busy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCheck {
    pub resource: String,
    pub status: CheckStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> RecoveryReport {
        RecoveryReport {
            coverage: "plugin".into(),
            inspected: 0,
            remaining: 0,
            status: RecoveryStatus::Recovered,
            message: "全量核对完成".into(),
            checks: vec![RecoveryCheck {
                resource: "资源登记".into(),
                status: CheckStatus::Confirmed,
                message: "无残留".into(),
            }],
        }
    }
    #[test]
    fn recovered_requires_explicit_global_coverage_nonempty_checks_and_zero_remaining() {
        let mut value = report();
        assert!(value.validate());
        value.coverage = "device".into();
        assert!(!value.validate());
        value = report();
        value.remaining = 1;
        assert!(!value.validate());
        value = report();
        value.checks.clear();
        assert!(!value.validate());
        value = report();
        value.checks[0].status = CheckStatus::Busy;
        assert!(!value.validate());
    }
    #[test]
    fn report_limits_cannot_be_bypassed_by_long_messages_or_extra_fields() {
        let mut value = report();
        value.message = "测".repeat(501);
        assert!(!value.validate());
        value = report();
        value.checks = vec![value.checks[0].clone(); 65];
        assert!(!value.validate());
        let mut json = serde_json::to_value(report()).unwrap();
        json["force"] = true.into();
        assert!(serde_json::from_value::<RecoveryReport>(json).is_err());
    }
}
