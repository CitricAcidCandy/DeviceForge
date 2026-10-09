//! 独立插件的异步请求与合作取消运行库，不引用宿主模块。
mod framing;
use apk_plugin_sdk::{ArtifactOutput, Request, Response, cooperative::*};
use serde_json::Value;
use std::future::Future;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

pub struct Output {
    pub value: Value,
    pub artifacts: Vec<ArtifactOutput>,
}
impl From<Value> for Output {
    fn from(value: Value) -> Self {
        Self {
            value,
            artifacts: Vec::new(),
        }
    }
}
pub struct Execution {
    pub outcome: Result<Output, String>,
    pub cleanup: CleanupOutcome,
}
impl Execution {
    /// 仅在处理器已完成所有自有资源清理后调用。
    pub fn complete(outcome: Result<Output, String>) -> Self {
        Self {
            outcome,
            cleanup: CleanupOutcome::Complete,
        }
    }
}

pub async fn serve_once<F, Fut>(handler: F) -> Result<(), String>
where
    F: FnOnce(Request, CancellationToken) -> Fut,
    Fut: Future<Output = Execution>,
{
    serve_io(tokio::io::stdin(), tokio::io::stdout(), handler).await
}

/// 可注入传输便于验证；生产插件使用 serve_once。
pub async fn serve_io<R, W, F, Fut>(reader: R, mut writer: W, handler: F) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce(Request, CancellationToken) -> Fut,
    Fut: Future<Output = Execution>,
{
    let mut reader = BufReader::new(reader);
    let bytes = framing::line(&mut reader, REQUEST_LIMIT)
        .await?
        .ok_or("缺少请求帧")?;
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "请求不符合公开协议")?;
    if request.protocol_version != COOPERATIVE_PROTOCOL_VERSION
        || request.request_id.is_empty()
        || request.request_id.len() > 128
    {
        return Err("运行库要求协议 3 和有效请求 ID".into());
    }
    let id = request.request_id.clone();
    let cancel = CancellationToken::new();
    let work = handler(request, cancel.clone());
    tokio::pin!(work);
    let control = async {
        match framing::line(&mut reader, CONTROL_LIMIT).await? {
            None => Ok::<_, String>(()),
            Some(bytes) => {
                let frame: ControlFrame =
                    serde_json::from_slice(&bytes).map_err(|_| "控制帧无效")?;
                if frame.protocol_version != COOPERATIVE_PROTOCOL_VERSION || frame.request_id != id
                {
                    return Err("控制帧版本或请求 ID 不匹配".into());
                }
                Ok(())
            }
        }
    };
    let execution = tokio::select! {
        biased;
        signal = control => {
            cancel.cancel();
            let mut execution = work.await;
            execution.outcome = Err(signal.err().unwrap_or_else(|| "操作已取消或宿主连接已关闭".into()));
            execution
        },
        execution = &mut work => execution,
    };
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
    let mut reply = CooperativeResponse {
        response: Response {
            protocol_version: COOPERATIVE_PROTOCOL_VERSION,
            request_id: id,
            result,
            error,
            outputs,
        },
        cleanup: execution.cleanup,
    };
    let mut bytes = serde_json::to_vec(&reply).map_err(|_| "响应序列化失败")?;
    if bytes.len() >= RESPONSE_LIMIT {
        reply.response.result = None;
        reply.response.outputs.clear();
        reply.response.error = Some("响应超过 1 MiB".into());
        bytes = serde_json::to_vec(&reply).map_err(|_| "响应序列化失败")?;
    }
    bytes.push(b'\n');
    writer.write_all(&bytes).await.map_err(|_| "响应写入失败")?;
    writer.shutdown().await.map_err(|_| "响应流关闭失败".into())
}
