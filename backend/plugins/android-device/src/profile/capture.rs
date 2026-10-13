//! 原进程代际、真实计数和设备boottime采样；媒体由独立持续流模块补齐。
use super::{
    derived,
    models::{Identity, Options, Sample},
    rules,
};
use crate::{Error, Result, rules::performance, session::Session};
use std::time::Duration;

impl Session {
    pub(crate) async fn profile_identity(&self, device: &str, package: &str) -> Result<Identity> {
        let pid = self
            .performance_read(device, &["pidof", "-s", package], |text, _| {
                performance::pid(text)
            })
            .await?;
        let path = format!("/proc/{pid}/stat");
        let (_, start) = self
            .performance_read(device, &["cat", &path], move |text, _| {
                performance::process(text, pid)
            })
            .await?;
        let path = format!("/proc/{pid}/status");
        let result = self
            .performance_read(device, &["cat", &path], move |text, check| {
                performance::fps::uid(text, pid, check)
            })
            .await;
        self.control.check()?;
        let uid = match result {
            Ok(value) => value,
            Err(Error::Dependency(_)) => None,
            Err(error) => return Err(error),
        };
        Ok(Identity { pid, start, uid })
    }
    pub(crate) async fn profile_uptime(&self, device: &str) -> Result<u64> {
        self.performance_read(device, &["cat", "/proc/uptime"], |text, _| {
            rules::uptime(text)
        })
        .await
    }
    pub(crate) async fn profile_samples(
        &self,
        device: &str,
        options: &Options,
        identity: &Identity,
    ) -> Result<Vec<Sample>> {
        let started = tokio::time::Instant::now();
        let until = started
            .checked_add(Duration::from_millis(options.duration_ms))
            .ok_or(Error::TooLarge)?;
        let mut next = started;
        let mut samples = Vec::new();
        let mut previous = None;
        loop {
            self.profile_wait(next).await?;
            if samples.len() >= 16 {
                return Err(Error::TooLarge);
            }
            let begin = self.profile_uptime(device).await?;
            let metrics = self
                .sample(device.to_owned(), options.package.clone())
                .await?
                .value;
            if metrics.get("pid").and_then(serde_json::Value::as_u64)
                != Some(u64::from(identity.pid))
                || metrics
                    .get("process_start_ticks")
                    .and_then(serde_json::Value::as_u64)
                    != Some(identity.start)
            {
                return Err(Error::Dependency("录制期间应用进程已换代"));
            }
            let end = rules::end(begin, self.profile_uptime(device).await?)?;
            let (metrics, derived_value, current) = self
                .work(move |check| {
                    check()?;
                    let current: apk_plugin_sdk::PerformanceSample =
                        serde_json::from_value(metrics.clone())
                            .map_err(|_| Error::Invalid("性能原始采样无法按公开契约解析"))?;
                    let value = derived::from_sample(&current, previous.as_ref());
                    check()?;
                    Ok((metrics, value, current))
                })
                .await?;
            previous = Some(current);
            samples.push(Sample {
                index: samples.len(),
                begin_ns: begin.to_string(),
                end_ns: end.to_string(),
                target_ns: (begin + (end - begin) / 2).to_string(),
                metrics,
                derived: Some(derived_value),
                frame: None,
                stack_sample_indices: Vec::new(),
            });
            let now = tokio::time::Instant::now();
            if now >= until {
                break;
            }
            next = next
                .checked_add(Duration::from_millis(options.interval_ms))
                .ok_or(Error::TooLarge)?;
            if next >= until {
                self.profile_wait(until).await?;
                break;
            }
            // 计数采集耗时跨过多个计划点时跳到未来计划点，不回放积压的历史采样。
            while next < now {
                next = next
                    .checked_add(Duration::from_millis(options.interval_ms))
                    .ok_or(Error::TooLarge)?;
            }
            if next >= until {
                self.profile_wait(until).await?;
                break;
            }
        }
        if self.profile_identity(device, &options.package).await? != *identity {
            return Err(Error::Dependency("录制结束时应用进程身份或UID无法复核"));
        }
        Ok(samples)
    }
    async fn profile_wait(&self, at: tokio::time::Instant) -> Result<()> {
        let stop = self.control.context.cancellation();
        tokio::select! { biased;
            _=tokio::time::sleep_until(self.control.context.deadline().into())=>Err(Error::Timeout),
            _=stop.cancelled()=>Err(Error::Cancelled),
            _=tokio::time::sleep_until(at)=>self.control.check(),
        }
    }
}
