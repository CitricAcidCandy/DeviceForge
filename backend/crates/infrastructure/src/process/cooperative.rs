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
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
    time::Instant,
};
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

async fn response_bytes(stdout: impl AsyncRead + Unpin, received: &Notify) -> Result<Vec<u8>> {
    let mut reader = BufReader::new(stdout).take(RESPONSE_LIMIT as u64 + 1);
    let mut bytes = Vec::new();
    reader
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| Error::CleanupFailed)?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Error::CleanupFailed);
    }
    if bytes.last() == Some(&b'\n') {
        // 响应帧后关闭宿主输入，使插件的标准输入读取线程可以结束。
        received.notify_one();
    }
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::CleanupFailed)?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Error::CleanupFailed);
    }
    Ok(bytes)
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
    let mut stdin = Some(stdin);
    let result = if sent {
        let received = Notify::new();
        let work = async {
            let (output, _errors, status) =
                tokio::try_join!(response_bytes(stdout, &received), bounded(stderr), async {
                    child.wait().await.map_err(|_| Error::CleanupFailed)
                })?;
            if !status.success() {
                return Err(Error::CleanupFailed);
            }
            confirm(&output, call.request_id)
        };
        tokio::pin!(work);
        enum Completion {
            Finished(Result<Response>),
            Interrupted(CancelReason),
        }
        let completion = loop {
            tokio::select! {
                biased;
                _ = call.cancel.cancelled() => break Completion::Interrupted(CancelReason::Cancelled),
                _ = tokio::time::sleep_until(deadline) => break Completion::Interrupted(CancelReason::Timeout),
                _ = received.notified(), if stdin.is_some() => { drop(stdin.take()); },
                result = &mut work => break Completion::Finished(result),
            }
        };
        match completion {
            Completion::Finished(result) => {
                guard.confirmed = result.is_ok();
                // 输出上限等提前错误也必须走下面的显式终止和等待，不能提前返回。
                result.map_err(|_| Error::CleanupFailed)
            }
            Completion::Interrupted(reason) => {
                let grace = Instant::now() + Duration::from_millis(1250);
                let frame = ControlFrame {
                    protocol_version: COOPERATIVE_PROTOCOL_VERSION,
                    request_id: call.request_id.to_owned(),
                    command: ControlCommand::Cancel,
                    reason,
                };
                let mut bytes = serde_json::to_vec(&frame).map_err(|_| Error::CleanupFailed)?;
                bytes.push(b'\n');
                let notified = match stdin.as_mut() {
                    Some(stdin) => matches!(
                        tokio::time::timeout_at(grace, stdin.write_all(&bytes)).await,
                        Ok(Ok(()))
                    ),
                    // 已读到响应后输入 EOF 已通知插件，仍须等到零退出才能确认。
                    None => true,
                };
                // 保持读取状态；取消后收到响应也须关闭输入，避免等零退出时互相等待。
                let cleaned = if notified {
                    loop {
                        tokio::select! {
                            biased;
                            _ = tokio::time::sleep_until(grace) => break false,
                            _ = received.notified(), if stdin.is_some() => { drop(stdin.take()); },
                            result = &mut work => break result.is_ok(),
                        }
                    }
                } else {
                    false
                };
                if cleaned {
                    guard.confirmed = true;
                    tracing::info!(cleanup = "complete", "合作插件取消清理已确认");
                    match reason {
                        CancelReason::Timeout => Err(Error::Timeout),
                        _ => Err(Error::Cancelled),
                    }
                } else {
                    Err(Error::CleanupFailed)
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_confirmation_requires_matching_wrapper_and_exclusive_payload() {
        let valid = serde_json::json!({"response":{"protocol_version":3,"request_id":"timeout-request","result":null},"cleanup":"complete"});
        assert!(confirm(&serde_json::to_vec(&valid).unwrap(), "timeout-request").is_ok());
        for mutation in [
            serde_json::json!({"response":{"protocol_version":3,"request_id":"wrong","result":null},"cleanup":"complete"}),
            serde_json::json!({"response":{"protocol_version":2,"request_id":"timeout-request","result":null},"cleanup":"complete"}),
            serde_json::json!({"response":{"protocol_version":3,"request_id":"timeout-request","result":null,"error":"失败"},"cleanup":"complete"}),
            serde_json::json!({"response":{"protocol_version":3,"request_id":"timeout-request","error":" "},"cleanup":"complete"}),
            serde_json::json!({"response":{"protocol_version":3,"request_id":"timeout-request","error":"失败","outputs":[{"filename":"late.json"}]},"cleanup":"complete"}),
            serde_json::json!({"response":{"protocol_version":3,"request_id":"timeout-request","result":null},"cleanup":"failed"}),
        ] {
            assert!(matches!(
                confirm(&serde_json::to_vec(&mutation).unwrap(), "timeout-request"),
                Err(Error::CleanupFailed)
            ));
        }
    }

    #[tokio::test]
    async fn real_timeout_notifies_reason_and_confirms_cleanup_within_outer_budget() {
        // 独立 Node 夹具只读取当前调用帧，验证宿主真实 timeout 控制原因。
        let script = r#"
            const readline = require('node:readline');
            const lines = readline.createInterface({ input: process.stdin });
            let request;
            lines.on('line', line => {
                const frame = JSON.parse(line);
                if (!request) { request = frame; return; }
                const valid = frame.protocol_version === 3 && frame.request_id === request.request_id
                    && frame.command === 'cancel' && frame.reason === 'timeout';
                process.stdout.write(JSON.stringify({ response: { protocol_version:3, request_id:request.request_id,
                    error:valid ? '模拟超时清理完成' : '控制帧错误' }, cleanup:valid ? 'complete' : 'failed' }) + '\n');
                // 输入保持打开时进程继续存活，宿主须在响应后关闭 stdin。
                lines.on('close', () => process.exit(0));
            });
        "#;
        let args = vec!["-e".into(), script.into()];
        let input = b"{\"protocol_version\":3,\"request_id\":\"timeout-request\",\"operation\":\"wait\",\"input\":{}}\n".to_vec();
        let unresolved = Arc::new(AtomicBool::new(false));
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            run(
                Invocation {
                    executable: "node",
                    args: &args,
                    input,
                    request_id: "timeout-request",
                    cancel: CancellationToken::new(),
                    directory: None,
                    timeout: Duration::from_millis(500),
                },
                unresolved.clone(),
            ),
        )
        .await
        .expect("总期限和合作清理必须有界");
        assert!(matches!(result, Err(Error::Timeout)));
        assert!(!unresolved.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn real_unresponsive_timeout_marks_unresolved_and_finishes_within_cleanup_budget() {
        let args = vec!["-e".into(), "setInterval(() => {}, 1000)".into()];
        let unresolved = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run(
                Invocation {
                    executable: "node",
                    args: &args,
                    input: b"{}\n".to_vec(),
                    request_id: "timeout-request",
                    cancel: CancellationToken::new(),
                    directory: None,
                    timeout: Duration::from_millis(50),
                },
                unresolved.clone(),
            ),
        )
        .await
        .expect("1250 ms 合作及 500 ms 终止须留在外层 2 秒内");
        assert!(matches!(result, Err(Error::CleanupFailed)));
        assert!(unresolved.load(Ordering::Acquire));
        assert!(started.elapsed() >= Duration::from_millis(1250));
    }

    #[tokio::test]
    async fn cancelled_before_spawn_creates_no_unresolved_resource() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let unresolved = Arc::new(AtomicBool::new(false));
        let result = run(
            Invocation {
                executable: "不存在的入口",
                args: &[],
                input: vec![],
                request_id: "request",
                cancel,
                directory: None,
                timeout: Duration::from_secs(1),
            },
            unresolved.clone(),
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!unresolved.load(Ordering::Acquire));
    }
}
