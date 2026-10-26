//! 全台账扫描和恢复编排；设备标识只补足旧版协调状态的定位。
use super::{
    check, identity,
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
    let known_devices: BTreeSet<_> = records
        .iter()
        .map(|record| record.device_id.clone())
        .collect();
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
        "恢复使用共享进程租约，仅尝试取得各条旧资源的独占租约",
    )];
    let mut busy = false;
    let mut pending = 0;
    let mut failed_devices = BTreeSet::new();
    for record in records {
        runner.check()?;
        let Some(lease) = pin(root, &record).await? else {
            let owner = record.owner.clone();
            if store::io(move || process::alive(&owner)).await? {
                checks.push(check(
                    "活跃投屏资源",
                    CheckStatus::Confirmed,
                    "已跳过仍由活跃调用持有的独立资源，不计入旧清理债务",
                ));
                continue;
            }
            busy = true;
            pending += 1;
            failed_devices.insert(control::key(&record.device_id));
            checks.push(check(
                "投屏资源",
                CheckStatus::Busy,
                "旧调用已退出但工具资源租约仍被持有，未发送设备命令",
            ));
            continue;
        };
        // 枚举之后旧持有人可能已正常退出；固定租约后重读阶段，不重放旧快照。
        let Some(mut record) = ledger::reload(root, &record).await? else {
            continue;
        };
        if !local_gone(&record).await? {
            busy = true;
            pending += 1;
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
        if result.is_err() {
            pending += 1;
            failed_devices.insert(control::key(&record.device_id));
        }
        checks.push(match result {
            Ok(()) => {
                // 控制债务另有持久状态；不能因新会话活跃而扣住已释放的旧资源记录。
                remove(root, &record).await?;
                check(
                    "投屏资源",
                    CheckStatus::Confirmed,
                    "远端进程、独占目录和精确转发均已核对释放",
                )
            }
            Err(error) => check("投屏资源", CheckStatus::Blocked, error),
        });
    }
    let mut control_remaining = 0;
    let mut control_failed = false;
    let mut active_controls = 0;
    let mut control_message = "全部控制协调状态均已核对".to_owned();
    let mut legacy_remaining = 0;
    let mut no_devices = false;
    let mut online = None;
    if empty_without_target {
        // 宿主重启会丢失旧风险布尔；空登记本身不能证明旧版 DFML 无资源。
        let devices = runner.devices().await?;
        inspected += devices.len() as u32;
        no_devices = devices.is_empty();
        let mut message = if no_devices {
            "当前无已登记资源或在线设备；新调用可分配独立资源".to_owned()
        } else {
            "全部在线设备的旧版目录、进程、套接字和转发均已只读核对".to_owned()
        };
        if no_devices && host_unconfirmed {
            legacy_remaining = 1;
            message = "宿主仍有未确认清理风险，但无设备可审计，请连接并选择故障设备后重试".into();
        }
        for device in &devices {
            runner.check()?;
            identities.insert(control::key(device), device.clone());
            if let Err(error) = runner::legacy_audit(runner, device).await {
                legacy_remaining += 1;
                failed_devices.insert(control::key(device));
                message = error;
            }
        }
        online = Some(devices);
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
    let mut missing = BTreeSet::new();
    for key in &keys {
        runner.check()?;
        if !identities.contains_key(key)
            && control::inspect(root, key, false).await? == Inspection::NeedsProof
        {
            missing.insert(key.clone());
        }
    }
    if !missing.is_empty() {
        let devices = match online {
            Some(devices) => devices,
            None => runner.devices().await?,
        };
        identity::resolve(&missing, &devices, &mut identities, runner).await?;
    }
    for key in &keys {
        runner.check()?;
        match control::inspect(root, key, false).await? {
            Inspection::Active => {
                active_controls += 1;
                continue;
            }
            Inspection::Busy => {
                busy = true;
                control_remaining += 1;
                control_message = "部分控制状态仍被持有，后台继续保留待办".into();
                continue;
            }
            _ => {}
        }
        let result = if failed_devices.contains(key) {
            Err("关联设备资源尚未释放，控制状态继续阻断".into())
        } else {
            reconcile_control(root, key, identities.get(key).map(String::as_str), runner).await
        };
        if let Err(error) = result {
            control_remaining += 1;
            control_failed = true;
            failed_devices.insert(key.clone());
            control_message = error;
        }
    }
    // 空台账也不跳过明确指定旧设备的审计。
    if let Some(target) = target
        && !keys.contains(&control::key(target))
        && !known_devices.contains(target)
        && let Err(error) = runner::legacy_audit(runner, target).await
    {
        control_remaining += 1;
        control_failed = true;
        control_message = error;
    }
    if active_controls > 0 && control_remaining == 0 {
        control_message = format!(
            "已跳过{active_controls}条活跃控制会话，其余旧状态均已核对；未重置活跃状态或重放输入"
        );
    }
    checks.push(check(
        "控制协调状态",
        if control_failed {
            CheckStatus::Blocked
        } else if control_remaining == 0 {
            CheckStatus::Confirmed
        } else {
            CheckStatus::Busy
        },
        control_message,
    ));
    let left = ledger::read_all(root).await?;
    let mut resource_remaining = 0;
    for record in left {
        runner.check()?;
        let lease = pin(root, &record).await?;
        if lease.is_none() {
            let owner = record.owner.clone();
            if store::io(move || process::alive(&owner)).await? {
                continue;
            }
        } else if ledger::reload(root, &record).await?.is_none() {
            continue;
        }
        resource_remaining += 1;
    }
    let latest_controls = control::list(root).await?;
    let mut latest_remaining = 0;
    let mut latest_blocked = false;
    for key in &latest_controls {
        runner.check()?;
        if !keys.contains(key) {
            inspected += 1;
        }
        match control::inspect(root, key, false).await? {
            Inspection::Clean | Inspection::Active => {}
            Inspection::Busy => {
                busy = true;
                latest_remaining += 1;
            }
            Inspection::NeedsProof => {
                latest_remaining += 1;
                latest_blocked = true;
            }
        }
    }
    checks.push(check(
        "控制状态复核",
        if latest_blocked {
            CheckStatus::Blocked
        } else if latest_remaining > 0 {
            CheckStatus::Busy
        } else {
            CheckStatus::Confirmed
        },
        "已复核恢复期间的控制变化；活跃状态跳过，新旧未确认状态均保留待办",
    ));
    // 复扫包含恢复期间新登记的记录；本轮失败不能被另一恢复调用的删除冲销。
    let remaining = resource_remaining.max(pending)
        + control_remaining.max(latest_remaining)
        + legacy_remaining;
    checks.push(check(
        "全插件台账复核",
        if remaining == 0 {
            CheckStatus::Confirmed
        } else {
            CheckStatus::Blocked
        },
        if remaining == 0 {
            "全量扫描完成，无待回收旧债务；活跃独立资源保持不动"
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
            "当前无已登记资源或在线设备；新调用可分配独立资源"
        }
        RecoveryStatus::Recovered => "已完成旧资源核对；活跃会话及新调用可继续使用独立资源",
        RecoveryStatus::Busy => "旧资源租约仍被持有，后台保留待办；独立新调用不受阻断",
        RecoveryStatus::Blocked => "部分旧资源尚未确认释放，保留后台债务；独立新调用不受阻断",
    };
    Ok(report(status, message, checks, inspected, remaining))
}

async fn reconcile_control(
    root: &Path,
    key: &str,
    device: Option<&str>,
    runner: &mut impl RecoveryRunner,
) -> Result<(), String> {
    let snapshot = control::snapshot(root, key).await?;
    match snapshot.inspection {
        Inspection::Active | Inspection::Busy => {
            return Err("控制会话仍存活，未重置控制状态".into());
        }
        Inspection::NeedsProof => {
            let device = device.ok_or("旧控制状态缺少资源台账，请指定对应设备后执行严格核对")?;
            runner::legacy_audit(runner, device).await?;
        }
        Inspection::Clean => return Ok(()),
    }
    match control::confirm(root, key, snapshot).await? {
        Inspection::Clean => Ok(()),
        _ => Err("控制状态在核对期间发生变化，保留原有阻断".into()),
    }
}
