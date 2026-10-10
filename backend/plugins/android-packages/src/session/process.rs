//! 公共工具执行和并发输出监测；不返回任意stderr原文。
use super::{Session, Watch};
use crate::{
    config::Tool,
    error::{Error, Result},
};
use deviceforge_tool_process::{Environment, ExecutionOptions, ToolCommand, capture_with_lease};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct ToolGuard {
    unresolved: Arc<AtomicBool>,
    confirmed: bool,
}
impl Drop for ToolGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
        }
    }
}

impl Session {
    async fn capture(
        &self,
        tool: Tool,
        args: Vec<String>,
        cancel: CancellationToken,
        monitor_stop: Option<&CancellationToken>,
    ) -> Result<String> {
        self.context.check()?;
        let (executable, prefix) = self.config.command(tool, &self.context).await?;
        let args: Vec<String> = prefix.into_iter().chain(args).collect();
        let deadline = tokio::time::Instant::from_std(self.context.deadline())
            .min(tokio::time::Instant::now() + Duration::from_secs(120));
        let options = ExecutionOptions::new(deadline);
        let mut command = ToolCommand::new(&executable, &args);
        command.directory = Some(&self.root);
        command.environment = Environment::Restricted;
        for key in ["TEMP", "TMP", "TMPDIR"] {
            command.env.insert(key.into(), self.root.as_os_str().into());
        }
        self.context.check()?;
        let mut guard = ToolGuard {
            unresolved: self.unresolved.clone(),
            confirmed: false,
        };
        let running = capture_with_lease(command, options, cancel.clone(), self.lease.clone());
        tokio::pin!(running);
        let result = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => None,
            _ = cancel.cancelled() => None,
            result = &mut running => Some(result),
        };
        if result.as_ref().is_none_or(|result| result.is_err()) || monitor_stop.is_some() {
            self.cleanup_point()?;
        }
        if let Some(stop) = monitor_stop {
            stop.cancel();
        }
        let result = match result {
            Some(result) => result,
            None => {
                let until = self.cleanup_point()?;
                match tokio::time::timeout_at(until, &mut running).await {
                    Ok(result) => result,
                    Err(_) => {
                        cancel.cancel();
                        return Err(Error::CleanupFailed);
                    }
                }
            }
        };
        guard.confirmed = !matches!(
            result,
            Err(deviceforge_tool_process::Error::CleanupFailed { .. })
        );
        let output = result.map_err(|error| match error {
            deviceforge_tool_process::Error::Cancelled => Error::Cancelled,
            deviceforge_tool_process::Error::Timeout => Error::Timeout,
            deviceforge_tool_process::Error::OutputTooLarge { .. } => Error::TooLarge,
            deviceforge_tool_process::Error::CleanupFailed { .. } => Error::CleanupFailed,
            _ => Error::Dependency("工具执行失败，请检查部署配置"),
        })?;
        self.context.check()?;
        String::from_utf8(output.stdout).map_err(|_| Error::Dependency("工具标准输出不是UTF-8"))
    }

    pub(crate) async fn tool(&self, tool: Tool, args: Vec<String>) -> Result<String> {
        self.capture(tool, args, self.context.cancellation().child_token(), None)
            .await
    }

    pub(crate) async fn monitored(
        &self,
        tool: Tool,
        args: Vec<String>,
        watch: Watch,
    ) -> Result<String> {
        self.context.check()?;
        let tool_cancel = self.context.cancellation().child_token();
        let monitor_stop = CancellationToken::new();
        let running = async {
            let result = self
                .capture(tool, args, tool_cancel.clone(), Some(&monitor_stop))
                .await;
            let point = self.cleanup_point();
            monitor_stop.cancel();
            point?;
            result
        };
        let watching = async {
            let result = self.monitor(watch, &monitor_stop).await;
            if result.is_err() {
                let point = self.cleanup_point();
                tool_cancel.cancel();
                point?;
            }
            result
        };
        let (tool_result, monitor_result) = tokio::join!(running, watching);
        if matches!(tool_result, Err(Error::CleanupFailed))
            || matches!(monitor_result, Err(Error::CleanupFailed))
        {
            return Err(Error::CleanupFailed);
        }
        monitor_result?;
        let output = tool_result?;
        self.resume_after_monitor()?;
        Ok(output)
    }

    async fn monitor(&self, watch: Watch, stop: &CancellationToken) -> Result<()> {
        let path = match &watch {
            Watch::File { path, .. } | Watch::Tree { path, .. } => path,
        };
        if !path.starts_with(&self.root)
            || path == &self.root
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(Error::Invalid("监测路径不属于私有工作目录"));
        }
        let caller = self.context.cancellation();
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => return Ok(()),
                _ = tokio::time::sleep_until(self.context.deadline().into()) => return Err(Error::Timeout),
                _ = caller.cancelled() => return Err(Error::Cancelled),
                _ = interval.tick() => {},
            }
            let path = path.clone();
            let kind = match &watch {
                Watch::File { limit, .. } => (Some(*limit), None),
                Watch::Tree { profile, .. } => (None, Some(*profile)),
            };
            let result = self
                .work_stopping(stop.clone(), move |control| {
                    control.check()?;
                    let metadata = match std::fs::symlink_metadata(&path) {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                        Err(_) => return Err(Error::Io("工具输出监测失败")),
                    };
                    if metadata.file_type().is_symlink() || crate::config::paths::reparse(&metadata)
                    {
                        return Err(Error::Invalid("工具输出是链接或重解析点"));
                    }
                    if let Some(limit) = kind.0 {
                        if !metadata.is_file() {
                            return Err(Error::Invalid("工具输出不是普通文件"));
                        }
                        if metadata.len() > limit.min(super::FILE_LIMIT) {
                            return Err(Error::TooLarge);
                        }
                    } else if let Some(profile) = kind.1 {
                        deviceforge_android_package_core::archive::tree::scan(
                            &path, profile, control,
                        )?;
                    }
                    Ok(())
                })
                .await;
            if matches!(result, Err(Error::Cancelled)) && stop.is_cancelled() {
                self.context.check()?;
                return Ok(());
            }
            result?;
        }
    }
}
