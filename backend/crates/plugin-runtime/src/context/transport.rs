//! 协议 4 的有界握手及合作响应；不拥有业务资源。
use super::InvocationContext;
use crate::{Execution, framing};
use apk_plugin_sdk::{
    Request, Response,
    context::{CONTEXT_FRAME_LIMIT, CONTEXT_PROTOCOL_VERSION, ReadyFrame, StartFrame},
    cooperative::{CooperativeResponse, REQUEST_LIMIT, RESPONSE_LIMIT},
};
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::time::Instant;

pub(super) async fn handshake<R, W>(
    reader: &mut R,
    writer: &mut W,
) -> Result<(Request, InvocationContext), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let bytes = framing::line(reader, REQUEST_LIMIT)
        .await?
        .ok_or("缺少请求帧")?;
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "请求不符合公开协议")?;
    // 在发送 Ready 之前固定 C0；Start 的等待与传输不会重置该点。
    let origin = Instant::now();
    if request.protocol_version != CONTEXT_PROTOCOL_VERSION
        || request.request_id.is_empty()
        || request.request_id.len() > 128
    {
        return Err("上下文运行库要求协议 4 和有效请求 ID".into());
    }
    let ready = ReadyFrame::new(&request.request_id);
    let mut ready_bytes = serde_json::to_vec(&ready).map_err(|_| "Ready 序列化失败")?;
    if ready_bytes.len() >= CONTEXT_FRAME_LIMIT {
        return Err("握手帧超过 4 KiB".into());
    }
    ready_bytes.push(b'\n');
    writer
        .write_all(&ready_bytes)
        .await
        .map_err(|_| "Ready 写入失败")?;
    writer.flush().await.map_err(|_| "Ready 刷新失败")?;

    let bytes = framing::line(reader, CONTEXT_FRAME_LIMIT)
        .await?
        .ok_or("缺少 Start 帧")?;
    let start: StartFrame = serde_json::from_slice(&bytes).map_err(|_| "Start 帧无效")?;
    start.validate().map_err(str::to_owned)?;
    if start.request_id != request.request_id {
        return Err("Start 请求 ID 不匹配".into());
    }
    let context = InvocationContext::from_start(origin, start.remaining_timeout_ns)?;
    Ok((request, context))
}

pub(super) async fn reply<W: AsyncWrite + Unpin>(
    writer: &mut W,
    id: String,
    execution: Execution,
) -> Result<(), String> {
    let (result, error, outputs) = match execution.outcome {
        Ok(output) => (Some(output.value), None, output.artifacts),
        Err(error) => (
            None,
            Some(if error.trim().is_empty() {
                "插件执行失败".into()
            } else {
                error
            }),
            Vec::new(),
        ),
    };
    let mut response = CooperativeResponse {
        response: Response {
            protocol_version: CONTEXT_PROTOCOL_VERSION,
            request_id: id,
            result,
            error,
            outputs,
        },
        cleanup: execution.cleanup,
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|_| "响应序列化失败")?;
    if bytes.len() >= RESPONSE_LIMIT {
        response.response.result = None;
        response.response.outputs.clear();
        response.response.error = Some("响应超过 1 MiB".into());
        bytes = serde_json::to_vec(&response).map_err(|_| "响应序列化失败")?;
    }
    bytes.push(b'\n');
    writer.write_all(&bytes).await.map_err(|_| "响应写入失败")?;
    writer.shutdown().await.map_err(|_| "响应流关闭失败".into())
}
