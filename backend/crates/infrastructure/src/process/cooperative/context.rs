//! 协议4把宿主原D的剩余预算交给先固定计时锚点的插件，不重新授时。
use apk_plugin_sdk::{
    context::*,
    cooperative::{CONTROL_LIMIT, CancelReason},
};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub(super) struct Interruption {
    pub reason: CancelReason,
    pub grace: Instant,
}

pub(super) enum StartOutcome {
    Started,
    Interrupted(Interruption),
    Failed,
}

fn interruption(deadline: Instant) -> Interruption {
    let now = Instant::now();
    let expired = now >= deadline;
    Interruption {
        reason: if expired {
            CancelReason::Timeout
        } else {
            CancelReason::Cancelled
        },
        grace: if expired { deadline } else { now } + Duration::from_millis(1250),
    }
}

pub(super) async fn start<R, W>(
    stdout: &mut BufReader<R>,
    stdin: &mut W,
    request_id: &str,
    deadline: Instant,
    cancel: &CancellationToken,
) -> StartOutcome
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // 保持同一次有界读取，取消不能丢弃已经收到的部分Ready或重开清理预算。
    let mut bytes = Vec::new();
    let interrupted = {
        let read = async {
            stdout
                .take(CONTROL_LIMIT as u64 + 1)
                .read_until(b'\n', &mut bytes)
                .await
        };
        tokio::pin!(read);
        let interrupted = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => Some(interruption(deadline)),
            _ = cancel.cancelled() => Some(interruption(deadline)),
            result = &mut read => {
                if result.is_err() { return StartOutcome::Failed; }
                None
            },
        };
        if let Some(signal) = &interrupted
            && !matches!(
                tokio::time::timeout_at(signal.grace, &mut read).await,
                Ok(Ok(_))
            )
        {
            return StartOutcome::Failed;
        }
        interrupted
    };
    if bytes.len() > CONTROL_LIMIT || bytes.last() != Some(&b'\n') {
        return StartOutcome::Failed;
    }
    let Ok(ready) = serde_json::from_slice::<ReadyFrame>(&bytes) else {
        return StartOutcome::Failed;
    };
    if ready.validate().is_err() || ready.request_id != request_id {
        return StartOutcome::Failed;
    }
    if let Some(signal) = interrupted {
        return StartOutcome::Interrupted(signal);
    }
    if Instant::now() >= deadline || cancel.is_cancelled() {
        return StartOutcome::Interrupted(interruption(deadline));
    }
    // 此计算发生在收到Ready之后，插件的C0发生在Ready发送之前。
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_nanos();
    let Ok(remaining_timeout_ns) = u64::try_from(remaining) else {
        return StartOutcome::Failed;
    };
    let frame = StartFrame {
        protocol_version: CONTEXT_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        command: StartCommand::Start,
        remaining_timeout_ns,
    };
    if frame.validate().is_err() {
        return StartOutcome::Failed;
    }
    let Ok(mut bytes) = serde_json::to_vec(&frame) else {
        return StartOutcome::Failed;
    };
    bytes.push(b'\n');
    let mut offset = 0;
    while offset < bytes.len() {
        let written = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => None,
            _ = cancel.cancelled() => None,
            result = stdin.write(&bytes[offset..]) => Some(result),
        };
        match written {
            None if offset == 0 => return StartOutcome::Interrupted(interruption(deadline)),
            // 部分Start不能拼接Cancel并自证清理，仍保留未确认资源。
            None | Some(Ok(0)) | Some(Err(_)) => return StartOutcome::Failed,
            Some(Ok(count)) => offset += count,
        }
    }
    StartOutcome::Started
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test(start_paused = true)]
    async fn interrupted_partial_ready_keeps_prefix_and_first_cleanup_deadline() {
        for timed_out in [false, true] {
            let (mut plugin_output, host_output) = tokio::io::duplex(4096);
            let (mut host_input, mut plugin_input) = tokio::io::duplex(4096);
            let cancel = CancellationToken::new();
            let origin = Instant::now();
            let deadline = origin + Duration::from_secs(1);
            let ready =
                b"{\"protocol_version\":4,\"request_id\":\"startup-1\",\"command\":\"ready\"}\n";
            let split = ready.len() / 2;
            plugin_output
                .write_all(&ready[..split])
                .await
                .expect("部分Ready");
            let observer = cancel.clone();
            let task = tokio::spawn(async move {
                start(
                    &mut BufReader::new(host_output),
                    &mut host_input,
                    "startup-1",
                    deadline,
                    &observer,
                )
                .await
            });
            tokio::task::yield_now().await;
            if timed_out {
                tokio::time::advance(Duration::from_secs(1)).await;
            } else {
                cancel.cancel();
                tokio::task::yield_now().await;
            }
            let first_signal = Instant::now();
            tokio::time::advance(Duration::from_millis(1200)).await;
            plugin_output
                .write_all(&ready[split..])
                .await
                .expect("同一Ready余字节");
            let StartOutcome::Interrupted(signal) = task.await.expect("启动读取器") else {
                panic!("完整匹配Ready后必须保留启动取消结果");
            };
            assert_eq!(signal.grace, first_signal + Duration::from_millis(1250));
            assert!(matches!(
                (timed_out, signal.reason),
                (false, CancelReason::Cancelled) | (true, CancelReason::Timeout)
            ));
            let mut sent = Vec::new();
            plugin_input
                .read_to_end(&mut sent)
                .await
                .expect("核对未发送Start");
            assert!(sent.is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn partially_written_start_cannot_be_replaced_with_cancel() {
        let (mut plugin_output, host_output) = tokio::io::duplex(4096);
        let (mut host_input, mut plugin_input) = tokio::io::duplex(1);
        plugin_output
            .write_all(
                b"{\"protocol_version\":4,\"request_id\":\"startup-1\",\"command\":\"ready\"}\n",
            )
            .await
            .expect("完整Ready");
        let cancel = CancellationToken::new();
        let observer = cancel.clone();
        let task = tokio::spawn(async move {
            start(
                &mut BufReader::new(host_output),
                &mut host_input,
                "startup-1",
                Instant::now() + Duration::from_secs(20),
                &observer,
            )
            .await
        });
        let mut first = [0u8; 1];
        plugin_input
            .read_exact(&mut first)
            .await
            .expect("实际部分Start");
        assert_eq!(first, [b'{']);
        cancel.cancel();
        assert!(matches!(
            task.await.expect("启动写入器"),
            StartOutcome::Failed
        ));
    }
    #[tokio::test(start_paused = true)]
    async fn cancellation_before_first_start_byte_uses_consumed_ready() {
        let (mut plugin_output, host_output) = tokio::io::duplex(4096);
        let (mut host_input, mut plugin_input) = tokio::io::duplex(1);
        host_input.write_all(b"x").await.expect("保持Start写端满");
        plugin_output
            .write_all(
                b"{\"protocol_version\":4,\"request_id\":\"startup-1\",\"command\":\"ready\"}\n",
            )
            .await
            .expect("完整Ready");
        let cancel = CancellationToken::new();
        let observer = cancel.clone();
        let task = tokio::spawn(async move {
            start(
                &mut BufReader::new(host_output),
                &mut host_input,
                "startup-1",
                Instant::now() + Duration::from_secs(20),
                &observer,
            )
            .await
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(matches!(
            task.await.expect("启动写入器"),
            StartOutcome::Interrupted(_)
        ));
        let mut sent = Vec::new();
        plugin_input
            .read_to_end(&mut sent)
            .await
            .expect("核对零Start字节");
        assert_eq!(sent, b"x");
    }
}
