//! 部分缺测的纯版本与值/原因联动规则；不推断不可读数值。
use super::ObservationAccess;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricUnavailableReason {
    PermissionDenied,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnavailableMetric {
    pub source: String,
    pub access: ObservationAccess,
    pub reason: MetricUnavailableReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricMissing {
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<UnavailableMetric>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<UnavailableMetric>,
}

impl UnavailableMetric {
    fn validate(&self) -> Result<(), &'static str> {
        if self.source.is_empty()
            || self.source.len() > 80
            || !self
                .source
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("缺测来源标识无效");
        }
        Ok(())
    }
}

impl MetricMissing {
    pub fn validate(
        &self,
        system_ticks: Option<u64>,
        logical_cpus: Option<u32>,
        pss_kib: Option<u64>,
        rss_kib: Option<u64>,
    ) -> Result<(), &'static str> {
        if self.api_version != 1 || self.cpu.is_none() && self.memory.is_none() {
            return Err("缺测版本无效或未包含真实缺测指标");
        }
        validate_counts(system_ticks, logical_cpus, pss_kib, rss_kib, Some(self))
    }
}

/// 无缺测对象的旧样本继续要求原有数值齐全；新缺测与诊断必须精确对应。
pub fn validate_counts(
    system_ticks: Option<u64>,
    logical_cpus: Option<u32>,
    pss_kib: Option<u64>,
    rss_kib: Option<u64>,
    missing: Option<&MetricMissing>,
) -> Result<(), &'static str> {
    if let Some(missing) = missing
        && (missing.api_version != 1 || missing.cpu.is_none() && missing.memory.is_none())
    {
        return Err("缺测版本无效或未包含真实缺测指标");
    }
    let cpu = missing.and_then(|missing| missing.cpu.as_ref());
    match (system_ticks, logical_cpus, cpu) {
        (Some(ticks), Some(cpus), None) if ticks > 0 && (1..=4096).contains(&cpus) => {}
        (None, None, Some(reason)) => reason.validate()?,
        _ => return Err("系统CPU计数、核数与缺测原因不一致"),
    }
    let memory = missing.and_then(|missing| missing.memory.as_ref());
    match (pss_kib, rss_kib, memory) {
        (Some(_), _, None) => {}
        (None, None, Some(reason)) => reason.validate()?,
        _ => return Err("内存数值与缺测原因不一致"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cpu() -> MetricMissing {
        MetricMissing {
            api_version: 1,
            cpu: Some(UnavailableMetric {
                source: "linux_proc.stat".into(),
                access: ObservationAccess::AdbShell,
                reason: MetricUnavailableReason::PermissionDenied,
            }),
            memory: None,
        }
    }
    #[test]
    fn missing_reason_exactly_matches_values_and_legacy_requires_complete_counts() {
        assert!(validate_counts(Some(1), Some(2), Some(0), None, None).is_ok());
        assert!(validate_counts(None, None, Some(0), None, None).is_err());
        assert!(cpu().validate(None, None, Some(0), None).is_ok());
        for (system, cores, pss, rss) in [
            (Some(1), Some(2), Some(0), None),
            (None, Some(2), Some(0), None),
            (None, None, None, None),
        ] {
            assert!(cpu().validate(system, cores, pss, rss).is_err());
        }
        let memory = MetricMissing {
            api_version: 1,
            cpu: None,
            memory: cpu().cpu,
        };
        assert!(memory.validate(Some(1), Some(2), None, None).is_ok());
        assert!(memory.validate(Some(1), Some(2), None, Some(0)).is_err());
    }
    #[test]
    fn bad_version_empty_reason_group_and_source_are_rejected() {
        for change in [0, 1, 2] {
            let mut value = cpu();
            match change {
                0 => value.api_version = 2,
                1 => value.cpu = None,
                _ => value.cpu.as_mut().unwrap().source = "bad/source".into(),
            }
            assert!(value.validate(None, None, Some(0), None).is_err());
        }
        for bytes in [
            r#"{"api_version":1,"cpu":{"source":"linux_proc.stat","access":"adb_shell","reason":"unknown"}}"#,
            r#"{"api_version":1,"cpu":{"source":"linux_proc.stat","access":"adb_shell","reason":"permission_denied","secret":1}}"#,
            r#"{"api_version":1,"extra":1}"#,
        ] {
            assert!(serde_json::from_str::<MetricMissing>(bytes).is_err());
        }
    }
}
