//! 单次五命令采样；解析占既有受限 worker，工具与收口共用原截止点和租约。
use super::Session;
use crate::{Error, Result, rules::performance};
use apk_plugin_sdk::PerformanceSample;
use deviceforge_plugin_runtime::Output;
use std::time::{SystemTime, UNIX_EPOCH};

impl Session {
    pub(super) async fn sample(&self, device_id: String, package: String) -> Result<Output> {
        let pid = self
            .performance_read(&device_id, &["pidof", "-s", &package], |output, _| {
                performance::pid(output)
            })
            .await?;
        let path = format!("/proc/{pid}/stat");
        let (_, start) = self
            .performance_read(&device_id, &["cat", &path], move |output, _| {
                performance::process(output, pid)
            })
            .await?;
        let (pss_kib, rss_kib) = self
            .performance_read(
                &device_id,
                &["dumpsys", "meminfo", "-s", &pid.to_string()],
                move |output, check| performance::memory(output, pid, check),
            )
            .await?;
        let (process_ticks, confirmed_start) = self
            .performance_read(&device_id, &["cat", &path], move |output, _| {
                performance::process(output, pid)
            })
            .await?;
        if start != confirmed_start {
            return Err(Error::Dependency("采样期间应用进程已重启"));
        }
        let (system_ticks, logical_cpus) = self
            .performance_read(&device_id, &["cat", "/proc/stat"], performance::system)
            .await?;
        self.work(move |check| {
            check()?;
            let captured_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|duration| u64::try_from(duration.as_millis()).ok())
                .ok_or(Error::Dependency("性能采样时钟无效"))?;
            let sample = PerformanceSample {
                captured_at,
                pid,
                process_start_ticks: start,
                process_ticks,
                system_ticks,
                logical_cpus,
                pss_kib,
                rss_kib,
                frame_window: None,
            };
            let value = serde_json::to_value(sample)
                .map_err(|_| Error::Dependency("性能采样结果无法编码"))?;
            check()?;
            Ok(Output::from(value))
        })
        .await
    }

    async fn performance_read<T: Send + 'static>(
        &self,
        device_id: &str,
        tail: &[&str],
        parse: impl FnOnce(&str, performance::Check<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.control.check()?;
        let mut args = vec!["-s".into(), device_id.into(), "shell".into(), "-T".into()];
        args.extend(tail.iter().map(|part| (*part).to_owned()));
        let captured = self.control.capture_scoped(&args).await?;
        self.work(move |check| {
            check()?;
            let output = performance::output(&captured.stdout, &captured.stderr)?;
            check()?;
            parse(&output, check)
        })
        .await
    }
}
