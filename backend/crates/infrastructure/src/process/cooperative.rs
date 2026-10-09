//! 协议 3 的开放输入流、有限合作清理与未确认资源标记。
use super::{bounded, command};
use apk_domain::{Error, Result};
use apk_plugin_sdk::{Response, cooperative::*};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, time::Instant};
use tokio_util::sync::CancellationToken;

pub(crate) struct Invocation<'a> {
    pub executable: &'a str,
    pub args: &'a [String],
    pub input: Vec<u8>,
    pub request_id: &'a str,
    pub cancel: CancellationToken,
    pub directory: Option<&'a Path>,
    pub timeout: Duration,
}
struct CleanupGuard {
    unresolved: Arc<AtomicBool>,
    confirmed: bool,
}
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.unresolved.store(true, Ordering::Release);
            tracing::warn!(cleanup = "unresolved", "合作插件资源未确认清理");
        }
    }
}
fn confirm(bytes: &[u8], request_id: &str) -> Result<Response> {
    let reply: CooperativeResponse =
        serde_json::from_slice(bytes).map_err(|_| Error::CleanupFailed)?;
    let response = reply.response;
    let payload_valid = match (&response.result, &response.error) {
        (Some(_), None) => true,
        (None, Some(error)) => !error.trim().is_empty() && response.outputs.is_empty(),
        _ => false,
    };
    if reply.cleanup != CleanupOutcome::Complete
        || response.protocol_version != COOPERATIVE_PROTOCOL_VERSION
        || response.request_id != request_id
        || !payload_valid
    {
        return Err(Error::CleanupFailed);
    }
    Ok(response)
}

pub(crate) async fn run(call: Invocation<'_>, unresolved: Arc<AtomicBool>) -> Result<Response> {
    if call.cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut cmd = command(call.executable, call.args, true);
    if let Some(directory) = call.directory {
        cmd.current_dir(directory);
        for key in ["TEMP", "TMP", "TMPDIR"] {
            cmd.env(key, directory);
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| Error::Dependency("合作插件进程启动失败".into()))?;
    let mut guard = CleanupGuard {
        unresolved,
        confirmed: false,
    };
    let mut stdin = child.stdin.take().ok_or(Error::CleanupFailed)?;
    let stdout = child.stdout.take().ok_or(Error::CleanupFailed)?;
    let stderr = child.stderr.take().ok_or(Error::CleanupFailed)?;
    let deadline = Instant::now() + call.timeout;
    let sent = tokio::select! {
        biased;
        _ = call.cancel.cancelled() => false,
        value = tokio::time::timeout_at(deadline, stdin.write_all(&call.input)) => matches!(value, Ok(Ok(()))),
    };
    let result = if sent {
        let work = async {
            let (output, _errors, status) =
                tokio::try_join!(bounded(stdout), bounded(stderr), async {
                    child.wait().await.map_err(|_| Error::CleanupFailed)
                })?;
            if !status.success() {
                return Err(Error::CleanupFailed);
            }
            confirm(&output, call.request_id)
        };
        tokio::pin!(work);
        let interrupted = tokio::select! {
            biased;
            _ = call.cancel.cancelled() => Some(CancelReason::Cancelled),
            _ = tokio::time::sleep_until(deadline) => Some(CancelReason::Timeout),
            result = &mut work => {
                guard.confirmed = result.is_ok();
                return result.map_err(|_| Error::CleanupFailed);
            },
        };
        let reason = interrupted.expect("中断分支必有原因");
        let grace = Instant::now() + Duration::from_millis(1250);
        let frame = ControlFrame {
            protocol_version: COOPERATIVE_PROTOCOL_VERSION,
            request_id: call.request_id.to_owned(),
            command: ControlCommand::Cancel,
            reason,
        };
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| Error::CleanupFailed)?;
        bytes.push(b'\n');
        let notified = tokio::time::timeout_at(grace, stdin.write_all(&bytes)).await;
        // 保持输出读取 Future 的内部状态，不能取消后重读而丢失已捕获的数据。
        if matches!(notified, Ok(Ok(())))
            && matches!(tokio::time::timeout_at(grace, &mut work).await, Ok(Ok(_)))
        {
            guard.confirmed = true;
            tracing::info!(cleanup = "complete", "合作插件取消清理已确认");
            match reason {
                CancelReason::Timeout => Err(Error::Timeout),
                _ => Err(Error::Cancelled),
            }
        } else {
            Err(Error::CleanupFailed)
        }
    } else {
        Err(Error::CleanupFailed)
    };
    // Drop 也触发 kill_on_drop；正常合作退出后这里只是关闭输入句柄。
    drop(stdin);
    if !guard.confirmed {
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            let _ = child.kill().await;
            let _ = child.wait().await;
        })
        .await;
    }
    result
}
