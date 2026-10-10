//! 协议4把宿主原D的剩余预算交给先固定计时锚点的插件，不重新授时。
use apk_plugin_sdk::{context::*, cooperative::CONTROL_LIMIT};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn start<R, W>(
    stdout: &mut BufReader<R>,
    stdin: &mut W,
    request_id: &str,
    deadline: Instant,
    cancel: &CancellationToken,
) -> bool
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // 先限制帧读入量，EOF、缺换行或任何非Ready内容不能启动业务。
    let mut bytes = Vec::new();
    let read = async {
        stdout
            .take(CONTROL_LIMIT as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .await
    };
    let received = tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep_until(deadline) => false,
        result = read => result.is_ok(),
    };
    if !received || bytes.len() > CONTROL_LIMIT || bytes.last() != Some(&b'\n') {
        return false;
    }
    let Ok(ready) = serde_json::from_slice::<ReadyFrame>(&bytes) else {
        return false;
    };
    if ready.validate().is_err() || ready.request_id != request_id {
        return false;
    }
    // 此计算发生在收到Ready之后，插件的C0发生在Ready发送之前。
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_nanos();
    let Ok(remaining_timeout_ns) = u64::try_from(remaining) else {
        return false;
    };
    let frame = StartFrame {
        protocol_version: CONTEXT_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        command: StartCommand::Start,
        remaining_timeout_ns,
    };
    if frame.validate().is_err() {
        return false;
    }
    let Ok(mut bytes) = serde_json::to_vec(&frame) else {
        return false;
    };
    bytes.push(b'\n');
    super::send_request(stdin, &bytes, deadline, cancel).await
}
