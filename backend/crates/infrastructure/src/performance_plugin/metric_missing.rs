//! SDK缺测诊断到领域类型的明确映射，不创建新的测量。
use apk_domain::performance as domain;
use apk_plugin_sdk as sdk;

fn metric(value: sdk::UnavailableMetric) -> domain::UnavailableMetric {
    domain::UnavailableMetric {
        source: value.source,
        access: match value.access {
            sdk::ObservationAccess::AdbShell => domain::ObservationAccess::AdbShell,
            sdk::ObservationAccess::RootShell => domain::ObservationAccess::RootShell,
        },
        reason: match value.reason {
            sdk::MetricUnavailableReason::PermissionDenied => {
                domain::MetricUnavailableReason::PermissionDenied
            }
            sdk::MetricUnavailableReason::Unsupported => {
                domain::MetricUnavailableReason::Unsupported
            }
        },
    }
}
pub(super) fn map(value: sdk::MetricMissing) -> domain::MetricMissing {
    domain::MetricMissing {
        api_version: value.api_version,
        cpu: value.cpu.map(metric),
        memory: value.memory.map(metric),
    }
}
