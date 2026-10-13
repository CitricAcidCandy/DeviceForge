use crate::{deployment::Deployment, dispatch, model};
use apk_plugin_sdk::{Request, session::SessionOpen};
use deviceforge_plugin_runtime::{Execution, InvocationContext, SessionInput, SessionOutput};
use std::{io::Cursor, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader};

pub async fn execute(
    request: Request,
    context: InvocationContext,
    deployment: Deployment,
) -> Execution {
    dispatch::execute(request, context, deployment).await
}

async fn first<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| "SDK插件首帧读取失败")?;
        if available.is_empty() {
            return Err("SDK插件缺少完整首帧".into());
        }
        let complete = available.iter().position(|byte| *byte == b'\n');
        let count = complete.map_or(available.len(), |index| index + 1);
        if count > (512 * 1024usize).saturating_sub(bytes.len()) {
            return Err("SDK插件首帧超过512KiB".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete.is_some() {
            return Ok(bytes);
        }
    }
}

pub async fn serve_io<R, W>(reader: R, writer: W) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_io_with_deployment(reader, writer, Deployment::current(&[])?).await
}

pub async fn serve_io_with_deployment<R, W>(
    reader: R,
    writer: W,
    deployment: Deployment,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let started = tokio::time::Instant::now();
    let mut reader = BufReader::new(reader);
    let bytes = tokio::time::timeout(Duration::from_secs(5), first(&mut reader))
        .await
        .map_err(|_| "SDK插件首帧超过五秒")??;
    let frame: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "SDK插件首帧不是JSON")?;
    let version = frame
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or("SDK插件首帧缺少协议版本")?;
    let reader = Cursor::new(bytes).chain(reader);
    match version {
        4 => {
            deviceforge_plugin_runtime::serve_io_with_context(
                reader,
                writer,
                move |request, context| execute(request, context, deployment.clone()),
            )
            .await
        }
        5 => {
            let remaining = Duration::from_secs(5)
                .checked_sub(started.elapsed())
                .filter(|duration| !duration.is_zero())
                .ok_or("SDK插件握手超过五秒")?;
            let options = deviceforge_plugin_runtime::session::SessionOptions {
                handshake_timeout: remaining,
                ..Default::default()
            };
            deviceforge_plugin_runtime::session::serve_session_io(
                reader,
                writer,
                options,
                move |open, context, input, output| {
                    execute_stream(open, context, input, output, deployment.clone())
                },
            )
            .await
        }
        _ => Err("SDK插件只接受任务协议4或会话协议5".into()),
    }
}

pub async fn execute_stream(
    open: SessionOpen,
    context: InvocationContext,
    _input: SessionInput,
    output: SessionOutput,
    deployment: Deployment,
) -> Execution {
    if open.operation != "sdk.stream" {
        return Execution::complete(Err("SDK协议5仅接受sdk.stream".into()));
    }
    let input = match model::parse(&open.operation, open.input) {
        Ok(model::Operation::Stream(input)) => input,
        Ok(_) => return Execution::complete(Err("SDK实时流输入操作不匹配".into())),
        Err(error) => return Execution::complete(Err(error)),
    };
    let config = match deployment.load_config().await {
        Ok(config) => std::sync::Arc::new(config),
        Err(error) => return Execution::complete(Err(error)),
    };
    let worker = match deployment.worker_entry().await {
        Ok(worker) => worker,
        Err(error) => return Execution::complete(Err(error)),
    };
    crate::session_runtime::run(config, context, worker, input, output).await
}
