//! 投屏私有恢复边界；全插件核对不能退化为单设备清标记。
pub(crate) mod atomic;
pub(crate) mod ledger;
mod process;
pub(crate) mod remote;
mod runner;
mod store;
mod sweep;
use apk_plugin_sdk::{
    Request,
    cooperative::CleanupOutcome,
    recovery::{CheckStatus, RecoveryCheck, RecoveryReport, RecoveryStatus},
};
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
pub(crate) use ledger::{Ledger, Record, Stage};
use serde_json::Value;
pub(crate) use store::process_lease;

fn target(input: &Value) -> Result<Option<&str>, String> {
    let input = input.as_object().ok_or("恢复输入必须是对象")?;
    match input.get("device_id") {
        None => Ok(None),
        Some(Value::String(value)) if ledger::device_id(value) => Ok(Some(value)),
        _ => Err("恢复目标设备标识无效".into()),
    }
}

fn host_cleanup_unconfirmed(input: &Value) -> Result<bool, String> {
    match input.get("_host_cleanup_unconfirmed") {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err("宿主资源风险标识必须是布尔值".into()),
    }
}

fn report(
    status: RecoveryStatus,
    message: &str,
    checks: Vec<RecoveryCheck>,
    inspected: u32,
    remaining: u32,
) -> RecoveryReport {
    RecoveryReport {
        status,
        message: message.into(),
        coverage: "plugin".into(),
        inspected,
        remaining,
        checks,
    }
}

fn check(resource: &str, status: CheckStatus, message: impl Into<String>) -> RecoveryCheck {
    RecoveryCheck {
        resource: resource.into(),
        status,
        message: message.into(),
    }
}

pub(crate) async fn execute(request: Request, context: InvocationContext) -> Execution {
    let lease = match process_lease(false).await {
        Ok(lease) => lease,
        Err(error) => return blocked(error),
    };
    execute_with_lease(request, context, lease).await
}

pub(crate) async fn execute_with_lease(
    request: Request,
    context: InvocationContext,
    lease: Option<std::sync::Arc<std::fs::File>>,
) -> Execution {
    let result = async {
        let target = target(&request.input)?.map(str::to_owned);
        let host_unconfirmed = host_cleanup_unconfirmed(&request.input)?;
        let Some(lease) = lease else {
            return Ok((
                report(
                    RecoveryStatus::Busy,
                    "仍有插件进程或工具租约在使用，请结束现有会话后重试",
                    vec![check(
                        "插件进程",
                        CheckStatus::Busy,
                        "排他恢复租约未取得，未修改任何设备资源",
                    )],
                    0,
                    1,
                ),
                false,
            ));
        };
        let root = store::root()?;
        let config = crate::config::read().await?;
        let mut runner = runner::Runner::new(&config, &context, lease);
        let report = sweep::all(&root, target.as_deref(), host_unconfirmed, &mut runner).await;
        Ok::<_, String>((report, runner.unconfirmed))
    }
    .await;
    match result {
        Ok((report, unconfirmed)) if report.validate() => Execution {
            outcome: serde_json::to_value(report)
                .map(Output::from)
                .map_err(|_| "恢复报告编码失败".into()),
            cleanup: if unconfirmed {
                CleanupOutcome::Failed
            } else {
                CleanupOutcome::Complete
            },
        },
        Ok(_) => Execution::complete(Err("恢复报告违反全插件核对契约".into())),
        Err(error) => blocked(error),
    }
}

fn blocked(error: String) -> Execution {
    let report = report(
        RecoveryStatus::Blocked,
        "资源核对未完成，保留原有阻断",
        vec![check("资源台账", CheckStatus::Blocked, error)],
        0,
        1,
    );
    Execution::complete(
        serde_json::to_value(report)
            .map(Output::from)
            .map_err(|_| "恢复报告编码失败".into()),
    )
}

pub(crate) enum AdmissionError {
    Busy(String),
    Unconfirmed(String),
}

pub(crate) async fn before_session(
    device: &str,
    config: &crate::config::Config,
    context: &InvocationContext,
) -> Result<(), AdmissionError> {
    let lease = process_lease(true)
        .await
        .map_err(AdmissionError::Unconfirmed)?
        .ok_or_else(|| AdmissionError::Busy("插件正在排他恢复，请稍后打开".into()))?;
    let root = store::root().map_err(AdmissionError::Unconfirmed)?;
    let gate = store::device_gate(&root, device).await.map_err(|error| {
        if error == "目标设备正在核对或登记资源" {
            AdmissionError::Busy(error)
        } else {
            AdmissionError::Unconfirmed(error)
        }
    })?;
    let mut runner = runner::Runner::new(config, context, lease);
    runner.device_gate = Some(gate);
    let result = sweep::device(&root, device, &mut runner).await;
    if runner.unconfirmed {
        return Err(AdmissionError::Unconfirmed(
            "ADB直播直接进程清理未确认".into(),
        ));
    }
    result.map_err(AdmissionError::Unconfirmed)
}

pub(crate) async fn new_record(
    device: &str,
    directory: &str,
    scid: &str,
    version: &str,
) -> Result<Ledger, String> {
    let owner = store::io(process::current).await?;
    let root = store::root()?;
    let _gate = store::device_gate(&root, device).await?;
    let token = directory
        .strip_prefix("/data/local/tmp/deviceforge_")
        .ok_or("资源目录身份无效")?
        .to_owned();
    Ledger::create(Record {
        version: 1,
        device_id: device.into(),
        token,
        directory: directory.into(),
        scid: scid.into(),
        port: None,
        server_version: version.into(),
        externally_managed: false,
        owner,
        directory_stage: Stage::Planned,
        upload_stage: Stage::Planned,
        forward_stage: Stage::Planned,
        server_stage: Stage::Planned,
        remote: None,
    })
    .await
}

pub(crate) async fn recording_intent(device: &str) -> Result<Ledger, String> {
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "无法生成录制资源身份")?
        .as_nanos() as u64;
    let token = format!(
        "{timestamp:016x}{:08x}{:08x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed) as u32
    );
    let owner = store::io(process::current).await?;
    let root = store::root()?;
    let _gate = store::device_gate(&root, device).await?;
    Ledger::create(Record {
        version: 1,
        device_id: device.into(),
        token,
        directory: String::new(),
        scid: String::new(),
        port: None,
        server_version: "external".into(),
        externally_managed: true,
        owner,
        directory_stage: Stage::Planned,
        upload_stage: Stage::Planned,
        forward_stage: Stage::Attempting,
        server_stage: Stage::Attempting,
        remote: None,
    })
    .await
}

pub(crate) async fn confirm_recording(
    ledger: &Ledger,
    config: &crate::config::Config,
    context: &InvocationContext,
    lease: std::sync::Arc<std::fs::File>,
) -> Result<(), String> {
    let mut runner = runner::Runner::new(config, context, lease);
    runner.resource_lease = Some(ledger.lease._resource.clone());
    runner::legacy_audit(&mut runner, &ledger.record.device_id).await?;
    ledger.remove().await
}

#[cfg(test)]
mod tests;
