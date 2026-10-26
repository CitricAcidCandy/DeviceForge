//! 旧控制摘要的传输身份核对；只读取在线设备属性，不修改设备资源。
use super::{ledger, runner::RecoveryRunner};
use crate::live::ownership::recovery::key;
use std::collections::{BTreeMap, BTreeSet};

fn serial(output: &[u8]) -> Result<&str, String> {
    let serial = std::str::from_utf8(output)
        .map_err(|_| "设备硬件标识不是有效文本")?
        .trim_end_matches(['\r', '\n']);
    if !ledger::device_id(serial) || serial.contains(['\r', '\n']) {
        return Err("设备硬件标识缺失或无效，不能关联旧控制状态".into());
    }
    Ok(serial)
}

pub(super) async fn resolve(
    missing: &BTreeSet<String>,
    devices: &[String],
    known: &mut BTreeMap<String, String>,
    runner: &mut impl RecoveryRunner,
) -> Result<(), String> {
    for device in devices {
        runner.check()?;
        let direct = key(device);
        if missing.contains(&direct) {
            known.insert(direct, device.clone());
        }
    }
    // 旧版只保存设备摘要。无线地址不能与 USB 硬件标识直接比较，必须实读核对。
    for device in devices {
        if missing.iter().all(|key| known.contains_key(key)) {
            break;
        }
        runner.check()?;
        let output = runner
            .command(
                device,
                vec!["shell".into(), "getprop".into(), "ro.serialno".into()],
            )
            .await?;
        let hardware = key(serial(&output)?);
        if missing.contains(&hardware) {
            if known
                .get(&hardware)
                .is_some_and(|existing| existing != device)
            {
                return Err("旧设备标识对应多个传输地址，请保留一个连接后核对".into());
            }
            known.insert(hardware, device.clone());
        }
    }
    Ok(())
}
