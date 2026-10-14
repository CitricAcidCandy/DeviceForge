use crate::process;
use apk_domain::{
    Error, Result, now,
    performance::{PerformanceProbe, PerformanceTarget, RawPerformance},
};
use async_trait::async_trait;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
mod parse;
pub mod store;

pub struct AndroidPerformance {
    pub adb: String,
}
impl AndroidPerformance {
    async fn output(
        &self,
        target: &PerformanceTarget,
        args: &[&str],
        deadline: Instant,
        cancel: CancellationToken,
    ) -> Result<String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(Error::Timeout)?;
        let mut command = vec![
            "-s".into(),
            target.device_id.clone(),
            "shell".into(),
            "-T".into(),
        ];
        command.extend(args.iter().map(|arg| (*arg).to_owned()));
        let output = process::run_text(&self.adb, &command, remaining, cancel).await?;
        let lower = output.to_ascii_lowercase();
        if [
            "permission denied",
            "permission denial",
            "no such file",
            "error:",
            "exception",
            "not found",
            "device offline",
            "unauthorized",
        ]
        .iter()
        .any(|text| lower.contains(text))
        {
            return Err(Error::Dependency("设备拒绝性能采样或进程已退出".into()));
        }
        Ok(output)
    }
}
#[async_trait]
impl PerformanceProbe for AndroidPerformance {
    fn capabilities(&self) -> apk_domain::performance::ProbeCapabilities {
        apk_domain::performance::ProbeCapabilities {
            source: "android_adb".into(),
            fps: false,
            device_observation: false,
            partial_metrics: false,
        }
    }
    async fn sample(
        &self,
        target: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance> {
        target.validate()?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = parse::pid(
            &self
                .output(
                    target,
                    &["pidof", "-s", &target.package],
                    deadline,
                    cancel.clone(),
                )
                .await?,
        )?;
        let path = format!("/proc/{pid}/stat");
        let (_, start) = parse::process(
            &self
                .output(target, &["cat", &path], deadline, cancel.clone())
                .await?,
            pid,
        )?;
        let (pss_kib, rss_kib) = parse::memory(
            &self
                .output(
                    target,
                    &["dumpsys", "meminfo", "-s", &pid.to_string()],
                    deadline,
                    cancel.clone(),
                )
                .await?,
            pid,
        )?;
        let (ticks, confirmed_start) = parse::process(
            &self
                .output(target, &["cat", &path], deadline, cancel.clone())
                .await?,
            pid,
        )?;
        if start != confirmed_start {
            return Err(Error::Dependency("性能采样期间进程身份已变化".into()));
        }
        let (system_ticks, logical_cpus) = parse::system(
            &self
                .output(target, &["cat", "/proc/stat"], deadline, cancel.clone())
                .await?,
        )?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let raw = RawPerformance {
            captured_at: now(),
            pid,
            process_start_ticks: start,
            process_ticks: ticks,
            system_ticks: Some(system_ticks),
            logical_cpus: Some(logical_cpus),
            pss_kib: Some(pss_kib),
            rss_kib,
            frame_window: None,
            device_observation: None,
            metric_missing: None,
        };
        raw.validate()?;
        Ok(raw)
    }
}
#[cfg(test)]
mod tests;
