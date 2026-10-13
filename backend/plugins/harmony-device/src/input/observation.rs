use super::qualify_until;
use crate::{Control, Error, Result};
use apk_plugin_sdk::devices::{CapabilityAvailability, PluginDevice};
use std::time::Duration;
use tokio::time::Instant;

pub(crate) async fn observe_devices(
    control: &Control,
    mut devices: Vec<PluginDevice>,
) -> Result<Vec<PluginDevice>> {
    control.check()?;
    if devices.len() > 128 {
        return Err(Error::Dependency("输入资格观测设备超过128条"));
    }
    let admission_until =
        (Instant::now() + Duration::from_secs(8)).min(control.context.deadline().into());
    for device in &mut devices {
        control.check()?;
        let (available, reason) =
            match qualify_until(control, &device.id, Some(admission_until)).await {
                Ok(true) => (true, None),
                Ok(false) => (false, Some("本次发现未完成输入资格探测")),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(Error::Timeout) => return Err(Error::Timeout),
                Err(Error::CleanupFailed) => return Err(Error::CleanupFailed),
                Err(_) => {
                    control.check()?;
                    (false, Some("设备uitest未通过当前固定输入档案资格探测"))
                }
            };
        device.capabilities.push(CapabilityAvailability {
            id: "input".into(),
            version: 1,
            available,
            reason: reason.map(str::to_owned),
        });
    }
    control.check()?;
    Ok(devices)
}

#[cfg(test)]
#[path = "tests/observation.rs"]
mod tests;
