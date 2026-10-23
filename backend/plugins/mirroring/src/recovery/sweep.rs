//! 全台账扫描和恢复编排；设备标识只补足旧版协调状态的定位。
use super::{
    check,
    ledger::{self, Record},
    process, report,
    runner::{self, RecoveryRunner},
    store,
};
use crate::live::ownership::recovery::{self as control, Inspection};
use apk_plugin_sdk::recovery::{CheckStatus, RecoveryReport, RecoveryStatus};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    path::Path,
    sync::Arc,
};

struct Entry {
    record: Record,
    _lease: Arc<File>,
    clean: bool,
}

async fn pin(root: &Path, record: &Record) -> Result<Option<Arc<File>>, String> {
    let path = root.join(format!("{}.lease", record.token));
    store::io(move || store::lock(&path, false)).await
}

async fn local_gone(record: &Record) -> Result<bool, String> {
    let owner = record.owner.clone();
    store::io(move || process::quiescent(&owner)).await
}

async fn remove(root: &Path, record: &Record) -> Result<(), String> {
    let path = record.path(root);
    store::io(move || std::fs::remove_file(path).map_err(|_| "资源确认后的台账撤销失败".into()))
        .await
}

pub(super) async fn all(
    root: &Path,
    target: Option<&str>,
    host_unconfirmed: bool,
    runner: &mut impl RecoveryRunner,
) -> RecoveryReport {
    match all_inner(root, target, host_unconfirmed, runner).await {
        Ok(report) => report,
        Err(error) => report(
            RecoveryStatus::Blocked,
            "全插件资源核对未完成，保留阻断",
            vec![check("全插件资源台账", CheckStatus::Blocked, error)],
            0,
            1,
        ),
    }
}

async fn all_inner(
    root: &Path,
    target: Option<&str>,
    host_unconfirmed: bool,
    runner: &mut impl RecoveryRunner,
) -> Result<RecoveryReport, String> {
    let records = ledger::read_all(root).await?;
    let keys = control::list(root).await?;
    let empty_without_target = records.is_empty() && target.is_none();
    let mut inspected = (records.len() + keys.len()) as u32;
    let mut identities: BTreeMap<_, _> = records
        .iter()
        .map(|record| (control::key(&record.device_id), record.device_id.clone()))
        .collect();
    if let Some(target) = target {
        identities.insert(control::key(target), target.into());
    }
    let mut checks = vec![check(
        "插件进程",
        CheckStatus::Confirmed,
        "已取得排他恢复租约，没有普通插件调用持有共享租约",
    )];
    let mut entries = Vec::new();
    let mut pending = 0;
    let mut busy = false;
    let mut failed_devices = BTreeSet::new();
    for mut record in records {
        let Some(lease) = pin(root, &record).await? else {
            pending += 1;
            busy = true;
            failed_devices.insert(control::key(&record.device_id));
            checks.push(check(
                "投屏资源",
                CheckStatus::Busy,
                "仍有存活资源持有人，未发送设备命令",
            ));
            continue;
        };
        if !local_gone(&record).await? {
            pending += 1;
            busy = true;
            failed_devices.insert(control::key(&record.device_id));
            checks.push(check(
                "投屏资源",
                CheckStatus::Busy,
                "旧插件进程或其直接子进程仍存活，未清理设备",
            ));
            continue;
        }
        runner.pin(Some(lease.clone()));
        let result = runner::recover(runner, root, &mut record).await;
        runner.pin(None);
        let clean = result.is_ok();
        if !clean {
            failed_devices.insert(control::key(&record.device_id));
        }
        checks.push(match result {
            Ok(()) => check(
                "投屏资源",
                CheckStatus::Confirmed,
                "远端进程、独占目录和精确转发均已核对释放",
            ),
            Err(error) => check("投屏资源", CheckStatus::Blocked, error),
        });
        entries.push(Entry {
            record,
            _lease: lease,
            clean,
        });
    }
    let mut control_remaining = 0;
    let mut control_message = "全部控制协调状态均已核对".to_owned();
    let mut legacy_remaining = 0;
    let mut no_devices = false;
    if empty_without_target {
        // 宿主重启会丢失旧风险布尔；空登记本身不能证明旧版 DFML 无资源。
        let devices = runner.devices().await?;
        inspected += devices.len() as u32;
        no_devices = devices.is_empty();
        let mut message = if no_devices {
            "当前无已登记资源或在线设备；新设备打开前仍须严格核对".to_owned()
        } else {
            "全部在线设备的旧版目录、进程、套接字和转发均已只读核对".to_owned()
        };
        if no_devices && host_unconfirmed {
            legacy_remaining = 1;
            message = "宿主仍有未确认清理风险，但无设备可审计，请连接并选择故障设备后重试".into();
        }
        for device in devices {
            runner.check()?;
            identities.insert(control::key(&device), device.clone());
            if let Err(error) = runner::legacy_audit(runner, &device).await {
                legacy_remaining += 1;
                failed_devices.insert(control::key(&device));
                message = error;
            }
        }
        checks.push(check(
            "旧版设备资源",
            if legacy_remaining == 0 {
                CheckStatus::Confirmed
            } else {
                CheckStatus::Blocked
            },
            message,
        ));
    }
    for key in &keys {
        let result = if failed_devices.contains(key) {
            Err("关联设备资源尚未释放，控制状态继续阻断".into())
        } else {
            reconcile_control(root, key, identities.get(key).map(String::as_str), runner).await
        };
        if let Err(error) = result {
            control_remaining += 1;
            failed_devices.insert(key.clone());
            control_message = error;
        }
    }
    // 空台账也不跳过明确指定旧设备的审计。
    if let Some(target) = target
        && !keys.contains(&control::key(target))
        && !entries.iter().any(|entry| entry.record.device_id == target)
        && let Err(error) = runner::legacy_audit(runner, target).await
    {
        control_remaining += 1;
        control_message = error;
    }
    checks.push(check(
        "控制协调状态",
        if control_remaining == 0 {
            CheckStatus::Confirmed
        } else {
            CheckStatus::Blocked
        },
        control_message,
    ));
    for entry in &entries {
        if entry.clean && !failed_devices.contains(&control::key(&entry.record.device_id)) {
            remove(root, &entry.record).await?;
        }
    }
    let left = ledger::read_all(root).await?;
    // 复扫成功且为空才能报告全插件覆盖；不能把部分检查或截断报告当成通过。
    let remaining = (left.len() as u32).max(pending) + control_remaining + legacy_remaining;
    checks.push(check(
        "全插件台账复核",
        if remaining == 0 {
            CheckStatus::Confirmed
        } else {
            CheckStatus::Blocked
        },
        if remaining == 0 {
            "全量扫描完成，无未确认资源记录"
        } else {
            "仍有未确认资源，已保留台账和阻断"
        },
    ));
    runner.check()?;
    let status = if remaining == 0 {
        RecoveryStatus::Recovered
    } else if busy
        && checks
            .iter()
            .all(|item| item.status != CheckStatus::Blocked || item.resource == "全插件台账复核")
    {
        RecoveryStatus::Busy
    } else {
        RecoveryStatus::Blocked
    };
    let message = match status {
        RecoveryStatus::Recovered if no_devices => {
            "当前无已登记资源或在线设备；新连接设备打开前仍须严格核对"
        }
        RecoveryStatus::Recovered => "全部已登记投屏资源已核对，可重新打开投屏",
        RecoveryStatus::Busy => "旧会话或工具仍在使用资源，请结束后重试",
        RecoveryStatus::Blocked => "部分资源未确认释放，请按检查提示处理后重试",
    };
    Ok(report(status, message, checks, inspected, remaining))
}

async fn reconcile_control(
    root: &Path,
    key: &str,
    device: Option<&str>,
    runner: &mut impl RecoveryRunner,
) -> Result<(), String> {
    match control::inspect(root, key, false).await? {
        Inspection::Active | Inspection::Busy => {
            return Err("控制会话仍存活，未重置控制状态".into());
        }
        Inspection::NeedsProof => {
            let device = device.ok_or("旧控制状态缺少资源台账，请指定对应设备后执行严格核对")?;
            runner::legacy_audit(runner, device).await?;
        }
        Inspection::Clean => {}
    }
    match control::inspect(root, key, true).await? {
        Inspection::Clean => Ok(()),
        _ => Err("控制状态在核对期间发生变化，保留原有阻断".into()),
    }
}

pub(super) async fn device(
    root: &Path,
    device: &str,
    runner: &mut impl RecoveryRunner,
) -> Result<(), String> {
    let records = ledger::read_all(root).await?;
    let known_device = records.iter().any(|record| record.device_id == device);
    let mut entries = Vec::new();
    for mut record in records
        .into_iter()
        .filter(|record| record.device_id == device)
    {
        let Some(lease) = pin(root, &record).await? else {
            let owner = record.owner.clone();
            if !store::io(move || process::alive(&owner)).await? {
                return Err("旧设备工具租约尚未释放，不能继续创建会话".into());
            }
            continue;
        };
        if !local_gone(&record).await? {
            return Err("目标设备旧直接进程仍存活，请结束后重新核对".into());
        }
        runner.pin(Some(lease.clone()));
        let result = runner::recover(runner, root, &mut record).await;
        runner.pin(None);
        result?;
        entries.push(Entry {
            record,
            _lease: lease,
            clean: true,
        });
    }
    let key = control::key(device);
    match control::inspect(root, &key, false).await? {
        Inspection::Busy => return Err("旧控制会话未释放，不能自动恢复".into()),
        Inspection::Active => {}
        Inspection::NeedsProof => {
            reconcile_control(root, &key, Some(device), runner).await?;
        }
        Inspection::Clean => {
            if !known_device {
                // 无可信台账的首次打开必须覆盖旧 DFML 无控制状态的迁移路径。
                runner::legacy_audit(runner, device).await?;
            }
            control::inspect(root, &key, true).await?;
        }
    }
    for entry in entries {
        remove(root, &entry.record).await?;
    }
    Ok(())
}
