//! 部署工具、原截止点和直接工具清理观测；不解析业务输出。
use super::TIMEOUT;
use crate::artifact_files::Temporary;
use crate::{execution_deadline, process};
use apk_domain::{Error, Result};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

/// 工具入口和固定前缀参数只由部署者提供。
#[derive(Clone)]
pub struct ToolCommand {
    pub executable: String,
    pub prefix: Vec<String>,
}

fn point(deadline: Option<std::time::Instant>) -> tokio::time::Instant {
    deadline
        .map(tokio::time::Instant::from_std)
        .unwrap_or_else(|| tokio::time::Instant::now() + TIMEOUT)
}

impl ToolCommand {
    pub fn executable(executable: String) -> Self {
        Self {
            executable,
            prefix: Vec::new(),
        }
    }
    pub fn java_jar(java: String, jar: String) -> Self {
        Self {
            executable: java,
            prefix: vec!["-Xmx256m".into(), "-jar".into(), jar],
        }
    }
    pub async fn output(&self, args: Vec<String>, cancel: CancellationToken) -> Result<String> {
        self.output_until(args, cancel, None).await
    }
    pub(crate) async fn output_until(
        &self,
        args: Vec<String>,
        cancel: CancellationToken,
        deadline: Option<std::time::Instant>,
    ) -> Result<String> {
        let point = point(deadline);
        execution_deadline::check(&cancel, Some(point))?;
        let args: Vec<_> = self.prefix.iter().cloned().chain(args).collect();
        let output =
            process::run_until(&self.executable, &args, None, point, cancel, false).await?;
        String::from_utf8(output).map_err(|_| Error::Dependency("工具标准输出不是 UTF-8".into()))
    }
}

#[derive(Default)]
pub(crate) struct Tracker(Arc<AtomicBool>);

impl Tracker {
    pub(crate) fn unresolved(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) async fn output_held(
        &self,
        command: &ToolCommand,
        args: Vec<String>,
        cancel: CancellationToken,
        deadline: Option<std::time::Instant>,
        lease: Arc<Temporary>,
    ) -> Result<String> {
        let deadline = point(deadline);
        execution_deadline::check(&cancel, Some(deadline))?;
        let args: Vec<_> = command.prefix.iter().cloned().chain(args).collect();
        let (output, _) = self
            .observe(process::package_output_until(
                &command.executable,
                &args,
                deadline,
                cancel,
                lease,
                false,
            ))
            .await?;
        String::from_utf8(output).map_err(|_| Error::Dependency("工具标准输出不是 UTF-8".into()))
    }

    #[cfg(test)]
    pub(crate) async fn output(
        &self,
        command: &ToolCommand,
        args: Vec<String>,
        cancel: CancellationToken,
        deadline: Option<std::time::Instant>,
    ) -> Result<String> {
        execution_deadline::check(&cancel, deadline.map(tokio::time::Instant::from_std))?;
        self.observe(command.output_until(args, cancel, deadline))
            .await
    }

    pub(crate) async fn observe<T>(
        &self,
        work: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let mut guard = Guard {
            unresolved: self.0.clone(),
            confirmed: false,
        };
        let result = work.await;
        // 普通返回由公共执行库确认直接进程退出；未确认标记不能被其他成功清零。
        guard.confirmed = !matches!(result, Err(Error::CleanupFailed));
        result
    }
}

struct Guard {
    unresolved: Arc<AtomicBool>,
    confirmed: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
            tracing::warn!(cleanup = "unresolved", "包工具直接进程退出未确认");
        }
    }
}

#[cfg(test)]
mod tests;
