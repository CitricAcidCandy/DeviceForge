//! 一代媒体连接与确定资源退出后重连；未确认资源粘性失败。
use super::{
    checked, control,
    device::Device,
    model::Open,
    wire::{self, Wire},
};
use crate::config::Config;
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use serde_json::json;
use tokio::io::AsyncReadExt;

pub(crate) async fn run(
    open: Open,
    config: Config,
    context: InvocationContext,
    mut input: SessionInput,
    output: SessionOutput,
) -> Execution {
    let mut last = "设备直播已断开".to_owned();
    for attempt in 0..=open.reconnect_attempts {
        if let Err(error) = context.check() {
            return Execution::complete(Err(error.to_string()));
        }
        let epoch = attempt + 1;
        let wire = Wire::new(output.clone(), epoch);
        if let Err(error) = wire
            .status(
                if attempt == 0 {
                    "connecting"
                } else {
                    "reconnecting"
                },
                attempt,
            )
            .await
        {
            return Execution::complete(Err(error));
        }
        let mut device = Device::new();
        let prepared = device.prepare(&config, &open, &context).await;
        let result = match prepared {
            Ok(()) => pump(&mut device, &open, &context, &mut input, &wire, epoch).await,
            Err(error) => {
                if error == "ADB直播直接进程清理未确认" {
                    device.unresolved = true;
                }
                Err(error)
            }
        };
        // pump 的套接字先全部退出作用域，再清理远端与精确转发。
        if !device.cleanup(&config, &open).await {
            return Execution {
                outcome: Err("设备直播资源清理未确认".into()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        match result {
            Ok(()) => {
                return Execution::complete(Ok(
                    json!({"device_id":open.device_id,"epoch":epoch,"live_stream":true}).into(),
                ));
            }
            Err(error) => last = error,
        }
        if context.check().is_err() || !retryable(&last) || attempt == open.reconnect_attempts {
            break;
        }
        if let Err(error) = checked(&context, async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            Ok(())
        })
        .await
        {
            last = error;
            break;
        }
    }
    Execution::complete(Err(last))
}
fn retryable(error: &str) -> bool {
    matches!(
        error,
        "媒体连接已断开"
            | "媒体载荷已截断"
            | "无法连接设备直播端口"
            | "设备直播服务器已退出"
            | "无法读取视频配置"
            | "无法读取音频配置"
            | "设备控制连接已断开"
    )
}
async fn pump(
    device: &mut Device,
    open: &Open,
    context: &InvocationContext,
    input: &mut SessionInput,
    wire: &Wire,
    epoch: u32,
) -> Result<(), String> {
    let mut video = device.connect(context).await?;
    let mut audio = if open.audio {
        Some(device.connect(context).await?)
    } else {
        None
    };
    let control = if open.control {
        Some(device.connect(context).await?)
    } else {
        None
    };
    wire::video_header(&mut video, context, wire).await?;
    if let Some(socket) = audio.as_mut()
        && !wire::audio_header(socket, context, wire, epoch - 1).await?
    {
        audio = None;
    }
    wire.status("streaming", epoch - 1).await?;
    let (control_read, control_write) = match control {
        Some(socket) => {
            let (read, write) = socket.into_split();
            (Some(read), Some(write))
        }
        None => (None, None),
    };
    let incoming = control::run(input, control_write, context, epoch);
    tokio::pin!(incoming);
    let video = media(video, context, wire, 2, false);
    let audio = async {
        if let Some(socket) = audio {
            media(socket, context, wire, 4, true).await
        } else {
            std::future::pending::<Result<(), String>>().await
        }
    };
    let control_read = async {
        if let Some(mut socket) = control_read {
            let mut bytes = [0; 8192];
            loop {
                // 自动剪贴板同步已关闭；仍排空有限块，防止设备 ACK 阻塞写路。
                let count = checked(context, async {
                    socket
                        .read(&mut bytes)
                        .await
                        .map_err(|_| "设备控制连接已断开".to_owned())
                })
                .await?;
                if count == 0 {
                    return Err("设备控制连接已断开".into());
                }
            }
        } else {
            std::future::pending::<Result<(), String>>().await
        }
    };
    tokio::pin!(video, audio, control_read);
    let cancel = context.cancellation();
    let mut eof = false;
    let mut eof_writer = None;
    loop {
        tokio::select! {
            biased;
            _=tokio::time::sleep_until(context.deadline().into())=>return Err("直播业务期限已到期".into()),
            _=cancel.cancelled()=>return Err("直播已取消".into()),
            result=&mut video=>return result,
            result=&mut audio=>return result,
            result=&mut control_read=>return result,
            result=&mut incoming,if !eof=>{eof_writer=result?;eof=true;},
            chunk=async {device.server.as_mut().ok_or("设备直播服务器缺失")?.recv().await.ok_or("设备直播服务器已退出") }=>{
                // 本地服务器诊断只排空，不输出路径、参数或任意工具内容。
                chunk?;
                // 持有 EOF 后的写半部直到整个媒体作用域结束。
                let _ = &eof_writer;
            },
        }
    }
}
async fn media(
    mut socket: tokio::net::TcpStream,
    context: &InvocationContext,
    wire: &Wire,
    kind: u8,
    audio: bool,
) -> Result<(), String> {
    loop {
        let (flags, pts, payload) = wire::packet(&mut socket, context, audio).await?;
        wire.send(kind, flags, pts, &payload).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reconnect_only_transport_failures() {
        assert!(retryable("媒体连接已断开"));
        assert!(!retryable("媒体载荷无效或超限"));
        assert!(!retryable("控制代次已过期或缺失"));
    }
}
