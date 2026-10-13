mod capture;

use super::{receipt, scripts};
use crate::{Control, Error, Result};
use std::sync::atomic::Ordering;

struct RemoteWaiting<'control> {
    control: &'control Control,
    confirmed: bool,
}

impl Drop for RemoteWaiting<'_> {
    fn drop(&mut self) {
        if !self.confirmed {
            self.control.unresolved.store(true, Ordering::Release);
            let _ = self.control.lease.cleanup_point();
        }
    }
}

pub(super) async fn run(
    control: &Control,
    device_id: &str,
    token: &str,
    stage: &str,
    command: &str,
) -> Result<receipt::Receipt> {
    control.check()?;
    let args = scripts::args(device_id, token, stage, command)?;
    let mut waiting = RemoteWaiting {
        control,
        confirmed: false,
    };
    let captured = capture::run(control, &args).await?;
    let receipt = receive(&mut waiting, &captured, token, stage)?;
    control.check()?;
    Ok(receipt)
}

fn receive(
    waiting: &mut RemoteWaiting<'_>,
    captured: &capture::Captured,
    token: &str,
    stage: &str,
) -> Result<receipt::Receipt> {
    let receipt = receipt::parse(&captured.stdout, token, stage)?;
    waiting.confirmed = true;
    if !captured.status.success() {
        return Err(Error::Dependency("HDC客户端执行失败，请检查部署配置"));
    }
    if captured
        .stderr
        .iter()
        .any(|byte| !byte.is_ascii_whitespace())
    {
        return Err(Error::Dependency("HDC输入客户端返回非空诊断"));
    }
    if receipt.status != 0 {
        return Err(Error::Dependency("Harmony输入远端命令执行失败"));
    }
    Ok(receipt)
}

#[cfg(test)]
#[path = "tests/execution.rs"]
mod tests;
