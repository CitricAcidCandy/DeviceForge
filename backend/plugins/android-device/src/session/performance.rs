//! 基础计数及可选展示帧采样；解析、工具与收口共用原期限和租约。
mod environment;
mod fps;
use super::Session;
use crate::{
    Error, Result,
    rules::{environment as environment_rules, performance},
};
use apk_plugin_sdk::{MetricMissing, ObservationAccess, PerformanceSample};
use deviceforge_plugin_runtime::Output;
use performance::missing::{self, Metric, Value};
use std::time::{SystemTime, UNIX_EPOCH};

impl Session {
    pub(crate) async fn sample(&self, device_id: String, package: String) -> Result<Output> {
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
        let access = if self.profile_root.is_some() {
            ObservationAccess::RootShell
        } else {
            ObservationAccess::AdbShell
        };
        let memory = self
            .performance_metric_read(
                &device_id,
                &["dumpsys", "meminfo", "-s", &pid.to_string()],
                Metric::Memory,
                move |output, check| performance::memory(output, pid, check),
            )
            .await?;
        let (pss_kib, rss_kib, memory_missing) = match memory {
            Value::Available((pss, rss)) => (Some(pss), rss, None),
            Value::Unavailable(reason) => {
                (None, None, Some(Metric::Memory.missing(access, reason)))
            }
        };
        let uid = self.performance_uid(&device_id, pid).await?;
        let frame_window = match uid {
            Some(uid) => self.frame_window(&device_id, &package, pid, uid).await?,
            None => None,
        };
        let raw_environment = self.environment_observation(&device_id).await?;
        let observed_device_id = device_id.clone();
        let device_observation = self
            .work(move |check| {
                environment_rules::observation(raw_environment, observed_device_id, check)
            })
            .await?;
        let (process_ticks, confirmed_start) = self
            .performance_read(&device_id, &["cat", &path], move |output, _| {
                performance::process(output, pid)
            })
            .await?;
        if start != confirmed_start {
            return Err(Error::Dependency("采样期间应用进程已重启"));
        }
        if let Some(uid) = uid
            && self.performance_uid(&device_id, pid).await? != Some(uid)
        {
            return Err(Error::Dependency("采样期间应用进程UID已变化或无法确认"));
        }
        let system = self
            .performance_metric_read(
                &device_id,
                &["cat", "/proc/stat"],
                Metric::Cpu,
                performance::system,
            )
            .await?;
        let (system_ticks, logical_cpus, cpu_missing) = match system {
            Value::Available((system, cores)) => (Some(system), Some(cores), None),
            Value::Unavailable(reason) => (None, None, Some(Metric::Cpu.missing(access, reason))),
        };
        let metric_missing =
            (cpu_missing.is_some() || memory_missing.is_some()).then_some(MetricMissing {
                api_version: 1,
                cpu: cpu_missing,
                memory: memory_missing,
            });
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
                metric_missing,
                frame_window,
                device_observation,
            };
            if let Some(missing) = &sample.metric_missing {
                missing
                    .validate(
                        sample.system_ticks,
                        sample.logical_cpus,
                        sample.pss_kib,
                        sample.rss_kib,
                    )
                    .map_err(|_| Error::Dependency("指标缺测不符合公开资格"))?;
            }
            if let Some(observation) = &sample.device_observation {
                observation
                    .validate(captured_at)
                    .map_err(|_| Error::Dependency("环境观测不符合公开资格"))?;
            }
            let value = serde_json::to_value(sample)
                .map_err(|_| Error::Dependency("性能采样结果无法编码"))?;
            check()?;
            Ok(Output::from(value))
        })
        .await
    }

    async fn performance_uid(&self, device_id: &str, pid: u32) -> Result<Option<u32>> {
        let path = format!("/proc/{pid}/status");
        let result = self
            .performance_read(device_id, &["cat", &path], move |output, check| {
                performance::fps::uid(output, pid, check)
            })
            .await;
        self.control.check()?;
        match result {
            Err(Error::Dependency(_)) => Ok(None),
            other => other,
        }
    }

    pub(crate) async fn performance_read<T: Send + 'static>(
        &self,
        device_id: &str,
        tail: &[&str],
        parse: impl FnOnce(&str, performance::Check<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.control.check()?;
        let args = self.performance_argv(device_id, tail);
        let captured = self.control.capture_scoped(&args).await?;
        self.work(move |check| {
            check()?;
            let output = performance::output(&captured.stdout, &captured.stderr)?;
            check()?;
            parse(&output, check)
        })
        .await
    }

    async fn performance_metric_read<T: Send + 'static>(
        &self,
        device_id: &str,
        tail: &[&str],
        metric: Metric,
        parse: impl FnOnce(&str, performance::Check<'_>) -> Result<T> + Send + 'static,
    ) -> Result<Value<T>> {
        self.control.check()?;
        let args = self.performance_argv(device_id, tail);
        let captured = self.control.capture_metric_scoped(&args, metric).await?;
        self.work(move |check| {
            check()?;
            match captured {
                Value::Unavailable(reason) => Ok(Value::Unavailable(reason)),
                Value::Available(captured) => {
                    match missing::output(metric, &captured.stdout, &captured.stderr)? {
                        Value::Unavailable(reason) => {
                            check()?;
                            Ok(Value::Unavailable(reason))
                        }
                        Value::Available(output) => {
                            check()?;
                            parse(&output, check).map(Value::Available)
                        }
                    }
                }
            }
        })
        .await
    }

    fn performance_argv(&self, device_id: &str, tail: &[&str]) -> Vec<String> {
        if let Some(root) = self.profile_root.as_ref() {
            crate::profile::root::argv(device_id, Some(root), tail)
        } else {
            let mut args = vec!["-s".into(), device_id.into(), "shell".into(), "-T".into()];
            args.extend(tail.iter().map(|part| (*part).to_owned()));
            args
        }
    }
}
