//! 协议 3 的开放输入流、有限合作清理与未确认资源标记。
use super::{bounded, command};
use apk_domain::{Error, Result};
use apk_plugin_sdk::context::CONTEXT_PROTOCOL_VERSION;
use apk_plugin_sdk::{Response, cooperative::*};
use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::Notify,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
mod context;

pub(crate) struct Invocation<'a> {
    pub executable: &'a str,
    pub args: &'a [String],
    pub input: Vec<u8>,
    pub request_id: &'a str,
    pub cancel: CancellationToken,
    pub directory: Option<&'a Path>,
    pub timeout: Duration,
    pub deadline: Option<std::time::Instant>,
    pub configuration: Option<&'a Path>,
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
#[cfg(test)]
fn confirm(bytes: &[u8], request_id: &str) -> Result<Response> {
    confirm_version(bytes, request_id, COOPERATIVE_PROTOCOL_VERSION)
}
fn confirm_version(bytes: &[u8], request_id: &str, protocol_version: u32) -> Result<Response> {
    let reply: CooperativeResponse =
        serde_json::from_slice(bytes).map_err(|_| Error::CleanupFailed)?;
    let response = reply.response;
    let payload_valid = match (&response.result, &response.error) {
        (Some(_), None) => true,
        (None, Some(error)) => !error.trim().is_empty() && response.outputs.is_empty(),
        _ => false,
    };
    if reply.cleanup != CleanupOutcome::Complete
        || response.protocol_version != protocol_version
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

fn cancellation_reason(deadline: Option<Instant>) -> CancelReason {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        // 启动后用户取消与总期限同刻发生时记为到期，避免外层取消掩盖原因。
        CancelReason::Timeout
    } else {
        CancelReason::Cancelled
    }
}

async fn send_request(
    stdin: &mut (impl AsyncWrite + Unpin),
    input: &[u8],
    deadline: Instant,
    cancel: &CancellationToken,
) -> bool {
    // spawn 可能已耗尽预算，首次轮询写端前必须再次检查。
    if cancel.is_cancelled() || Instant::now() >= deadline {
        return false;
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep_until(deadline) => false,
        result = stdin.write_all(input) => result.is_ok(),
    }
}

async fn send_request_with_errors<F>(
    stdin: &mut (impl AsyncWrite + Unpin),
    input: &[u8],
    deadline: Instant,
    cancel: &CancellationToken,
    mut errors: Pin<&mut F>,
    early_errors: &mut Option<Result<Vec<u8>>>,
) -> bool
where
    F: Future<Output = Result<Vec<u8>>>,
{
    let sending = send_request(stdin, input, deadline, cancel);
    tokio::pin!(sending);
    loop {
        tokio::select! {
            sent = &mut sending => return sent,
            result = &mut errors, if early_errors.is_none() => {
                if result.is_err() { return false; }
                *early_errors = Some(result);
            },
        }
    }
}

pub(crate) async fn run(call: Invocation<'_>, unresolved: Arc<AtomicBool>) -> Result<Response> {
    run_version(call, unresolved, COOPERATIVE_PROTOCOL_VERSION).await
}

pub(crate) async fn run_with_context(
    call: Invocation<'_>,
    unresolved: Arc<AtomicBool>,
) -> Result<Response> {
    run_version(call, unresolved, CONTEXT_PROTOCOL_VERSION).await
}

async fn run_version(
    call: Invocation<'_>,
    unresolved: Arc<AtomicBool>,
    protocol_version: u32,
) -> Result<Response> {
    let shared_deadline = call.deadline.map(Instant::from_std);
    crate::execution_deadline::check(&call.cancel, shared_deadline)?;
    let deadline = shared_deadline.unwrap_or_else(|| Instant::now() + call.timeout);
    if Instant::now() >= deadline {
        return Err(Error::Timeout);
    }
    let mut cmd = command(call.executable, call.args, true);
    if let Some(path) = call.configuration {
        cmd.env("DEVICEFORGE_PLUGIN_CONFIG", path);
    }
    if let Some(directory) = call.directory {
        cmd.current_dir(directory);
        for key in ["TEMP", "TMP", "TMPDIR"] {
            cmd.env(key, directory);
        }
    }
    // 配置命令后再次复核；到期先诊断 Timeout，不创建未启动进程的资源守卫。
    crate::execution_deadline::check(&call.cancel, Some(deadline))?;
    let mut child = cmd
        .spawn()
        .map_err(|_| Error::Dependency("合作插件进程启动失败".into()))?;
    let mut guard = CleanupGuard {
        unresolved,
        confirmed: false,
    };
    let mut stdin = child.stdin.take().ok_or(Error::CleanupFailed)?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or(Error::CleanupFailed)?);
    let stderr = child.stderr.take().ok_or(Error::CleanupFailed)?;
    let errors = bounded(stderr);
    tokio::pin!(errors);
    let mut early_errors = None;
    let mut sent = send_request_with_errors(
        &mut stdin,
        &call.input,
        deadline,
        &call.cancel,
        errors.as_mut(),
        &mut early_errors,
    )
    .await;
    let mut startup_interruption = None;
    if sent && protocol_version == CONTEXT_PROTOCOL_VERSION {
        let start = context::start(
            &mut stdout,
            &mut stdin,
            call.request_id,
            deadline,
            &call.cancel,
        );
        tokio::pin!(start);
        let outcome = loop {
            tokio::select! {
                result = &mut start => break result,
                result = &mut errors, if early_errors.is_none() => {
                    if result.is_err() { break context::StartOutcome::Failed; }
                    early_errors = Some(result);
                },
            }
        };
        match outcome {
            context::StartOutcome::Started => {}
            context::StartOutcome::Interrupted(signal) => startup_interruption = Some(signal),
            context::StartOutcome::Failed => sent = false,
        }
    }
    let mut stdin = Some(stdin);
    let result = if sent {
        let received = Notify::new();
        let work = async {
            let (output, _errors, status) = tokio::try_join!(
                response_bytes(stdout, &received),
                async {
                    match early_errors.take() {
                        Some(result) => result,
                        None => errors.await,
                    }
                },
                async { child.wait().await.map_err(|_| Error::CleanupFailed) }
            )?;
            if !status.success() {
                return Err(Error::CleanupFailed);
            }
            confirm_version(&output, call.request_id, protocol_version)
        };
        tokio::pin!(work);
        enum Completion {
            Finished(Result<Response>),
            Interrupted(CancelReason, Instant),
        }
        // 启动取消已经消耗Ready等待，后续控制、响应和退出共用首次清理绝对点。
        let completion = if let Some(signal) = startup_interruption {
            Completion::Interrupted(signal.reason, signal.grace)
        } else {
            loop {
                tokio::select! {
                    biased;
                    _ = call.cancel.cancelled() => break Completion::Interrupted(cancellation_reason(shared_deadline), Instant::now() + Duration::from_millis(1250)),
                    _ = tokio::time::sleep_until(deadline) => break Completion::Interrupted(CancelReason::Timeout, Instant::now() + Duration::from_millis(1250)),
                    _ = received.notified(), if stdin.is_some() => { drop(stdin.take()); },
                    result = &mut work => break Completion::Finished(result),
                }
            }
        };
        match completion {
            Completion::Finished(result) => {
                guard.confirmed = result.is_ok();
                // 输出上限等提前错误也必须走下面的显式终止和等待，不能提前返回。
                result.map_err(|_| Error::CleanupFailed)
            }
            Completion::Interrupted(reason, grace) => {
                let frame = ControlFrame {
                    protocol_version,
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

    #[tokio::test(start_paused = true)]
    async fn initial_request_and_startup_errors_drain_concurrently_on_bounded_pipes() {
        let (mut host_input, mut plugin_input) = tokio::io::duplex(64);
        let (mut plugin_errors, host_errors) = tokio::io::duplex(64);
        let payload = vec![0x41; 512];
        let expected = payload.clone();
        let errors = bounded(host_errors);
        tokio::pin!(errors);
        let mut early = None;
        let cancel = CancellationToken::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        let host = send_request_with_errors(
            &mut host_input,
            &payload,
            deadline,
            &cancel,
            errors.as_mut(),
            &mut early,
        );
        let plugin = async {
            // 先排空有限启动日志，再读业务请求；两条管道容量均小于数据。
            plugin_errors.write_all(&vec![0x42; 256]).await.unwrap();
            let mut received = vec![0; expected.len()];
            plugin_input.read_exact(&mut received).await.unwrap();
            assert_eq!(received, expected);
        };
        let (sent, ()) =
            tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(host, plugin) })
                .await
                .expect("两条有限管道不应互等到超时");
        assert!(sent, "必须在原D内完整发送请求");
    }

    async fn marker(path: &Path) {
        let watchdog = std::time::Instant::now();
        while !path.exists() {
            assert!(
                watchdog.elapsed() < Duration::from_secs(10),
                "真实进程未送达门闩"
            );
            // 保持宿主暂停时钟，真实进程启动耗时不替代受测数学截止点。
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn first_request_write_sends_no_business_bytes_when_expired_or_cancelled() {
        let input: &[u8] = b"{\"operation\":\"write\"}\n";
        for (expired, cancelled) in [(true, false), (false, true), (true, true), (false, false)] {
            // 整帧可立即写入，避免缓冲阻塞掩盖先轮询写端的错误。
            let (mut writer, mut spy) = tokio::io::duplex(1024);
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            let deadline = if expired {
                Instant::now() - Duration::from_secs(1)
            } else {
                Instant::now() + Duration::from_secs(60)
            };
            let sent = send_request(&mut writer, input, deadline, &cancel).await;
            drop(writer);
            let mut bytes = Vec::new();
            spy.read_to_end(&mut bytes).await.unwrap();
            if expired || cancelled {
                assert!(!sent);
                assert!(bytes.is_empty(), "拒绝首次写入时不能发送业务字节");
            } else {
                assert!(sent);
                assert_eq!(bytes.as_slice(), input);
            }
        }
    }

    #[test]
    fn cancellation_at_shared_deadline_is_timeout_but_earlier_cancel_is_cancelled() {
        assert!(matches!(cancellation_reason(None), CancelReason::Cancelled));
        assert!(matches!(
            cancellation_reason(Some(Instant::now() + Duration::from_secs(60))),
            CancelReason::Cancelled
        ));
        assert!(matches!(
            cancellation_reason(Some(Instant::now() - Duration::from_secs(1))),
            CancelReason::Timeout
        ));
    }

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

    #[tokio::test(start_paused = true)]
    async fn real_timeout_and_outer_cancel_keep_timeout_reason_and_confirm_cleanup() {
        // 独立 Node 夹具只读取当前调用帧，验证宿主真实 timeout 控制原因。
        let script = r#"
            const fs = require('node:fs');
            const readline = require('node:readline');
            const lines = readline.createInterface({ input: process.stdin });
            function publish(path, value) {
                fs.writeFileSync(`${path}.writing`, JSON.stringify(value));
                fs.renameSync(`${path}.writing`, path);
            }
            let request;
            lines.on('line', line => {
                const frame = JSON.parse(line);
                if (!request) { request = frame; publish(process.argv[1], frame); return; }
                publish(process.argv[2], frame);
                const valid = frame.protocol_version === 3 && frame.request_id === request.request_id
                    && frame.command === 'cancel' && frame.reason === 'timeout';
                process.stdout.write(JSON.stringify({ response: { protocol_version:3, request_id:request.request_id,
                    error:valid ? '模拟超时清理完成' : '控制帧错误' }, cleanup:valid ? 'complete' : 'failed' }) + '\n');
                // 输入保持打开时进程继续存活，宿主须在响应后关闭 stdin。
                lines.on('close', () => process.exit(0));
            });
        "#;
        let input = b"{\"protocol_version\":3,\"request_id\":\"timeout-request\",\"operation\":\"wait\",\"input\":{}}\n".to_vec();
        for outer_cancel in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let ready = directory.path().join("ready.json");
            let cancelled = directory.path().join("cancelled.json");
            let args = vec![
                "-e".into(),
                script.into(),
                ready.to_string_lossy().into_owned(),
                cancelled.to_string_lossy().into_owned(),
            ];
            let unresolved = Arc::new(AtomicBool::new(false));
            let cancel = CancellationToken::new();
            let deadline = Instant::now() + Duration::from_millis(500);
            let work = run(
                Invocation {
                    executable: "node",
                    args: &args,
                    input: input.clone(),
                    request_id: "timeout-request",
                    cancel: cancel.clone(),
                    directory: None,
                    configuration: None,
                    // 共享截止点不得被这个较短的兼容参数截断。
                    timeout: if outer_cancel {
                        Duration::from_millis(1)
                    } else {
                        Duration::from_millis(500)
                    },
                    deadline: outer_cancel.then_some(deadline.into_std()),
                },
                unresolved.clone(),
            );
            tokio::pin!(work);
            tokio::select! {
                result = &mut work => panic!("真实请求送达前不应结束：{result:?}"),
                () = marker(&ready) => {},
            }
            let request: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&ready).unwrap()).unwrap();
            assert_eq!(request["request_id"], "timeout-request");
            // 先证明真实首帧已读取，再推进原期限；不放宽生产清理窗口。
            tokio::time::advance(
                deadline.duration_since(Instant::now()) + Duration::from_millis(1),
            )
            .await;
            if outer_cancel {
                // 下一轮真实轮询中，已过期的令牌分支先就绪。
                cancel.cancel();
            }
            let result = tokio::select! {
                result = &mut work => result,
                () = async {
                    let watchdog = std::time::Instant::now();
                    loop {
                        assert!(watchdog.elapsed() < Duration::from_secs(10), "匹配响应与零退出未收敛");
                        tokio::task::yield_now().await;
                    }
                } => unreachable!(),
            };
            assert!(
                matches!(result, Err(Error::Timeout)),
                "outer_cancel={outer_cancel}，实际结果={result:?}"
            );
            let control: ControlFrame =
                serde_json::from_slice(&std::fs::read(&cancelled).unwrap()).unwrap();
            assert_eq!(control.request_id, "timeout-request");
            assert!(matches!(control.command, ControlCommand::Cancel));
            assert!(matches!(control.reason, CancelReason::Timeout));
            assert!(!unresolved.load(Ordering::Acquire));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn real_unresponsive_timeout_marks_unresolved_and_finishes_within_cleanup_budget() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("request-ready.json");
        let cancelled = directory.path().join("cancel-received.json");
        let script = r#"
const fs = require('node:fs');
const readline = require('node:readline');
let requested = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const path = process.argv[requested ? 2 : 1];
  fs.writeFileSync(`${path}.writing`, line);
  fs.renameSync(`${path}.writing`, path);
  requested = true;
});
setInterval(() => {}, 1000);
"#;
        let args = vec![
            "-e".into(),
            script.into(),
            ready.to_string_lossy().into_owned(),
            cancelled.to_string_lossy().into_owned(),
        ];
        let unresolved = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let work = run(
            Invocation {
                executable: "node",
                args: &args,
                input: b"{}\n".to_vec(),
                request_id: "timeout-request",
                cancel: CancellationToken::new(),
                directory: None,
                configuration: None,
                timeout: Duration::from_millis(50),
                deadline: None,
            },
            unresolved.clone(),
        );
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("首次请求前不应结束：{result:?}"),
            () = marker(&ready) => {},
        }
        assert_eq!(std::fs::read(&ready).unwrap(), b"{}");
        // 先证实请求真正送达，再推进原 50 ms 期限，保留 1 ms 计时器刻度。
        tokio::time::advance(Duration::from_millis(51)).await;
        tokio::select! {
            result = &mut work => panic!("取消控制送达前不应结束：{result:?}"),
            () = marker(&cancelled) => {},
        }
        let control: ControlFrame =
            serde_json::from_slice(&std::fs::read(&cancelled).unwrap()).unwrap();
        assert_eq!(control.request_id, "timeout-request");
        assert!(matches!(control.command, ControlCommand::Cancel));
        assert!(matches!(control.reason, CancelReason::Timeout));
        tokio::time::advance(Duration::from_millis(1249)).await;
        tokio::select! {
            biased;
            result = &mut work => panic!("1250 ms 合作窗口不能提前结束：{result:?}"),
            () = tokio::task::yield_now() => {},
        }
        assert!(!unresolved.load(Ordering::Acquire));
        tokio::time::advance(Duration::from_millis(2)).await;
        let result = tokio::select! {
            result = &mut work => result,
            () = async {
                let watchdog = std::time::Instant::now();
                loop {
                    assert!(watchdog.elapsed() < Duration::from_secs(10), "直接进程回收未收敛");
                    tokio::task::yield_now().await;
                }
            } => unreachable!(),
        };
        assert!(matches!(result, Err(Error::CleanupFailed)));
        assert!(unresolved.load(Ordering::Acquire));
        assert!(started.elapsed() >= Duration::from_millis(1300));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn expired_before_spawn_creates_no_unresolved_resource() {
        let unresolved = Arc::new(AtomicBool::new(false));
        let result = run(
            Invocation {
                executable: "不存在的入口",
                args: &[],
                input: vec![],
                request_id: "expired-request",
                cancel: CancellationToken::new(),
                directory: None,
                configuration: None,
                timeout: Duration::from_secs(3600),
                deadline: Some(std::time::Instant::now() - Duration::from_secs(1)),
            },
            unresolved.clone(),
        )
        .await;
        assert!(matches!(result, Err(Error::Timeout)));
        assert!(!unresolved.load(Ordering::Acquire));
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
                configuration: None,
                timeout: Duration::from_secs(1),
                deadline: Some(std::time::Instant::now() + Duration::from_secs(60)),
            },
            unresolved.clone(),
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!unresolved.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn expired_outer_cancellation_before_spawn_is_timeout_without_unresolved_resource() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let unresolved = Arc::new(AtomicBool::new(false));
        let result = run(
            Invocation {
                executable: "不存在的入口",
                args: &[],
                input: b"must-not-send\n".to_vec(),
                request_id: "expired-and-cancelled",
                cancel,
                directory: None,
                configuration: None,
                timeout: Duration::from_secs(3600),
                deadline: Some(std::time::Instant::now() - Duration::from_secs(1)),
            },
            unresolved.clone(),
        )
        .await;
        assert!(matches!(result, Err(Error::Timeout)));
        assert!(!unresolved.load(Ordering::Acquire));
    }
}
