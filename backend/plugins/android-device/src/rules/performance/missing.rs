//! 固定可选指标命令的明确拒绝诊断；未知输出仍交严格解析，不保存原诊断。
use crate::{Error, Result};
use apk_plugin_sdk::{MetricUnavailableReason, ObservationAccess, UnavailableMetric};
use deviceforge_tool_process::Error as ToolError;

#[derive(Clone, Copy)]
pub(crate) enum Metric {
    Cpu,
    Memory,
}

pub(crate) enum Value<T> {
    Available(T),
    Unavailable(MetricUnavailableReason),
}

impl Metric {
    pub(crate) fn missing(
        self,
        access: ObservationAccess,
        reason: MetricUnavailableReason,
    ) -> UnavailableMetric {
        UnavailableMetric {
            source: match self {
                Self::Cpu => "linux_proc.stat",
                Self::Memory => "android_dumpsys.meminfo",
            }
            .into(),
            access,
            reason,
        }
    }
}

pub(crate) fn nonzero(metric: Metric, error: &ToolError) -> Option<MetricUnavailableReason> {
    let ToolError::NonZeroExit {
        code: Some(1),
        stderr,
    } = error
    else {
        return None;
    };
    // 工具库此错误不保留 stdout；只接受完整 stderr，且不复用任何原数值。
    diagnostic(metric, b"", stderr)
}

pub(crate) fn diagnostic(
    metric: Metric,
    stdout: &[u8],
    stderr: &[u8],
) -> Option<MetricUnavailableReason> {
    let stdout = std::str::from_utf8(stdout).ok()?;
    let stderr = std::str::from_utf8(stderr).ok()?;
    let mut reason = None;
    for line in stdout.lines().chain(stderr.lines()) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let next = line_reason(metric, line)?;
        if reason.as_ref().is_some_and(|previous| *previous != next) {
            return None;
        }
        reason = Some(next);
    }
    reason
}

pub(crate) fn output(metric: Metric, stdout: &[u8], stderr: &[u8]) -> Result<Value<String>> {
    if let Some(reason) = diagnostic(metric, stdout, stderr) {
        return Ok(Value::Unavailable(reason));
    }
    // 拒绝或不支持诊断混入有效正文仍为错误；不能让宽松数值解析忽略这类尾行。
    for bytes in [stdout, stderr] {
        let text = String::from_utf8_lossy(bytes);
        for line in text.lines().map(str::trim) {
            let tool_diagnostic = match metric {
                Metric::Cpu => line.starts_with("cat:"),
                Metric::Memory => {
                    line.starts_with("dumpsys:") || line.starts_with("Permission Denial:")
                }
            };
            if tool_diagnostic
                || line_reason(metric, line).is_some()
                || unsupported_diagnostic(line)
            {
                return Err(Error::Dependency("设备拒绝性能采样或进程已退出"));
            }
        }
    }
    super::output(stdout, stderr).map(Value::Available)
}

fn unsupported_diagnostic(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    // 带接口名、路径或解释的不支持诊断只触发硬失败，不扩展可降级全文白名单。
    lower.contains("not supported")
        || lower.contains("not implemented")
        || lower
            .split(|character: char| {
                character.is_ascii_whitespace() || ":=()[]{};,/".contains(character)
            })
            .any(|word| word == "unsupported")
}

fn line_reason(metric: Metric, line: &str) -> Option<MetricUnavailableReason> {
    use MetricUnavailableReason::{PermissionDenied, Unsupported};
    match metric {
        Metric::Cpu => match line {
            "cat: /proc/stat: Permission denied" => Some(PermissionDenied),
            "cat: /proc/stat: Operation not supported"
            | "cat: /proc/stat: Function not implemented" => Some(Unsupported),
            _ => None,
        },
        Metric::Memory => match line {
            "dumpsys: meminfo: Permission denied" => Some(PermissionDenied),
            "dumpsys: meminfo: not supported" | "dumpsys: meminfo: Operation not supported" => {
                Some(Unsupported)
            }
            _ if dump_permission(line) => Some(PermissionDenied),
            _ => None,
        },
    }
}

fn dump_permission(line: &str) -> bool {
    // Android 的固定 DUMP 拒绝形状中仅调用方编号可变；编号和整个后缀都严格匹配。
    let Some(rest) = [
        "Permission Denial: can't dump meminfo from from pid=",
        "Permission Denial: can't dump meminfo from pid=",
        "Permission Denial: can't dump ActivityManager from from pid=",
    ]
    .into_iter()
    .find_map(|prefix| line.strip_prefix(prefix)) else {
        return false;
    };
    let Some((pid, rest)) = rest.split_once(", uid=") else {
        return false;
    };
    let Some(uid) = rest
        .strip_suffix(" without permission android.permission.DUMP")
        .or_else(|| rest.strip_suffix(" due to missing android.permission.DUMP permission"))
    else {
        return false;
    };
    identifier(pid) && identifier(uid)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u32>().is_ok()
}
