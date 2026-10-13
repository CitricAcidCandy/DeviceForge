use super::{
    framing::{CHUNK_LIMIT, Role, bytes},
    transport::{Identity, Incoming, Outgoing, split},
};
use crate::model::{PROFILE, PROMPT_CHAR_LIMIT, SDK_VERSION};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Accepted { remaining_ms: u64 },
    Output { stream: String, bytes: Vec<u8> },
    Exit { code: Option<i32> },
}

fn environment(name: &str, limit: usize) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= limit)
        .ok_or_else(|| "SDK代理环境未准备".into())
}

async fn input(
    outgoing: &Outgoing,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<(), String> {
    let mut reader = tokio::io::stdin();
    let mut buffer = vec![0; CHUNK_LIMIT];
    let mut total = 0usize;
    loop {
        let count = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => return Err("SDK代理输入期限已到期".into()),
            count = reader.read(&mut buffer) => count.map_err(|_| "SDK代理标准输入失败")?,
        };
        if count == 0 {
            break;
        }
        total = total.checked_add(count).ok_or("SDK代理输入计数溢出")?;
        if total > PROMPT_CHAR_LIMIT * 4 {
            return Err("SDK代理输入字节超限".into());
        }
        outgoing
            .send_until(
                deadline,
                cancel.clone(),
                json!({"kind":"stdin_bytes","bytes":&buffer[..count]}),
            )
            .await?;
    }
    outgoing
        .send_until(deadline, cancel, json!({"kind":"stdin_end"}))
        .await
}

async fn output(
    incoming: &mut Incoming,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<i32, String> {
    let mut stdout = tokio::io::stdout();
    let mut stderr = tokio::io::stderr();
    loop {
        let payload = incoming
            .read_until(deadline, cancel.clone())
            .await?
            .ok_or("SDK代理缺少退出帧")?;
        let reply: Reply =
            serde_json::from_value(payload.clone()).map_err(|_| "SDK代理输出帧无效")?;
        match reply {
            Reply::Output { stream, bytes: raw } => {
                let verified = bytes(&payload)?;
                if verified != raw {
                    return Err("SDK代理字节块验证失败".into());
                }
                let writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send) = match stream.as_str()
                {
                    "stdout" => &mut stdout,
                    "stderr" => &mut stderr,
                    _ => return Err("SDK代理输出通道无效".into()),
                };
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => return Err("SDK代理输出期限已到期".into()),
                    result = writer.write_all(&raw) => result.map_err(|_| "SDK代理标准输出失败")?,
                }
            }
            Reply::Exit { code } => {
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => return Err("SDK代理刷新期限已到期".into()),
                    result = async {
                        stdout.flush().await.map_err(|_| "SDK代理输出刷新失败")?;
                        stderr.flush().await.map_err(|_| "SDK代理诊断刷新失败")
                    } => result?,
                }
                return Ok(code.unwrap_or(1));
            }
            Reply::Accepted { .. } => return Err("SDK代理重复准入".into()),
        }
    }
}

pub async fn serve(args: Vec<String>) -> Result<i32, String> {
    if args.first().is_none_or(|argument| argument != "exec")
        || args.len() > 128
        || args
            .iter()
            .any(|argument| argument.len() > 32_768 || argument.contains('\0'))
    {
        return Err("SDK代理只接受固定exec参数".into());
    }
    let port_text = environment("DF_SDK_PROXY_PORT", 5)?;
    if !port_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("SDK代理端口无效".into());
    }
    let port: u16 = port_text.parse().map_err(|_| "SDK代理端口无效")?;
    if port == 0 {
        return Err("SDK代理端口无效".into());
    }
    let identity = Identity {
        call_id: environment("DF_SDK_CALL_ID", 64)?,
        nonce: environment("DF_SDK_NONCE", 64)?,
    };
    let stream = timeout(
        Duration::from_millis(1000),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| "SDK代理连接超时")?
    .map_err(|_| "SDK代理连接失败")?;
    let (mut incoming, outgoing) = split(stream, &identity, Role::Proxy, Role::Coordinator)?;
    let cancel = CancellationToken::new();
    let handshake = Instant::now() + Duration::from_millis(1000);
    outgoing.send_until(handshake, cancel.clone(), json!({"kind":"hello","profile":PROFILE,"sdk_version":SDK_VERSION,"process_id":std::process::id()})).await?;
    let payload = incoming
        .read_until(handshake, cancel.clone())
        .await?
        .ok_or("SDK代理缺少准入")?;
    let Reply::Accepted { remaining_ms } =
        serde_json::from_value(payload).map_err(|_| "SDK代理准入帧无效")?
    else {
        return Err("SDK代理未取得准入".into());
    };
    if remaining_ms == 0 || remaining_ms > 600_000 {
        return Err("SDK代理准入预算无效".into());
    }
    let deadline = Instant::now() + Duration::from_millis(remaining_ms);
    outgoing
        .send_until(deadline, cancel.clone(), json!({"kind":"exec","argv":args}))
        .await?;
    input(&outgoing, deadline, cancel.clone()).await?;
    output(&mut incoming, deadline, cancel).await
}
