//! 固定电池与当前 HAL 读取；沿现有进程控制、worker 与原期限。
use super::super::Session;
use crate::{
    Error, Result,
    rules::{environment, performance::Check},
};
use environment::{EnvironmentObservation, Observed};
use std::time::{SystemTime, UNIX_EPOCH};

impl Session {
    pub(super) async fn environment_observation(
        &self,
        device_id: &str,
    ) -> Result<EnvironmentObservation> {
        let sysfs_battery = self
            .optional_environment_read(
                device_id,
                &["cat", "/sys/class/power_supply/battery/uevent"],
                environment::battery_uevent,
            )
            .await?;
        let battery_service = self
            .optional_environment_read(
                device_id,
                &["dumpsys", "battery"],
                environment::battery_service,
            )
            .await?;
        let temperatures = self
            .optional_environment_read(
                device_id,
                &["dumpsys", "thermalservice"],
                |output, check| {
                    let values = environment::thermal_service(output, check)?;
                    Ok((!values.is_empty()).then_some(values))
                },
            )
            .await?
            .map(|observed| {
                observed
                    .value
                    .into_iter()
                    .map(|value| Observed {
                        observed_at: observed.observed_at,
                        value,
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.control.check()?;
        Ok(EnvironmentObservation {
            sysfs_battery,
            battery_service,
            temperatures,
        })
    }

    async fn optional_environment_read<T: Send + 'static>(
        &self,
        device_id: &str,
        tail: &[&str],
        parse: impl FnOnce(&str, Check<'_>) -> Result<Option<T>> + Send + 'static,
    ) -> Result<Option<Observed<T>>> {
        let result = self.performance_read(device_id, tail, parse).await;
        self.control.check()?;
        let value = match result {
            Err(Error::Dependency(_)) => return Ok(None),
            result => result?,
        };
        let Some(value) = value else {
            return Ok(None);
        };
        let observed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .ok_or(Error::Dependency("环境观测时钟无效"))?;
        self.control.check()?;
        Ok(Some(Observed { observed_at, value }))
    }
}
