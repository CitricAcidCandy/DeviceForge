//! 逐行控制解析有界，EOF 不关闭媒体；不保留或回放用户控制。
use super::{checked, model::Control};
use deviceforge_plugin_runtime::{InvocationContext, session::SessionInput};
use tokio::{io::AsyncWriteExt, net::tcp::OwnedWriteHalf};

pub(crate) async fn run(
    input: &mut SessionInput,
    socket: Option<OwnedWriteHalf>,
    context: &InvocationContext,
    epoch: u32,
) -> Result<Option<OwnedWriteHalf>, String> {
    let mut socket = socket;
    let mut line = Vec::new();
    loop {
        let chunk = input.recv().await.map_err(|error| error.to_string())?;
        let Some(chunk) = chunk else {
            if !line.is_empty() {
                return Err("控制输入末行缺少换行".into());
            }
            // 只关闭公开控制准入；保留写半部，避免 FIN 让设备服务器结束媒体。
            return Ok(socket);
        };
        for byte in chunk {
            if byte == b'\n' {
                let encoded = decode(&line, epoch)?;
                line.clear();
                let socket = socket.as_mut().ok_or("本次直播未启用控制")?;
                checked(context, async {
                    socket
                        .write_all(&encoded)
                        .await
                        .map_err(|_| "设备控制连接已断开".to_owned())
                })
                .await?;
            } else {
                if line.len() >= 4096 {
                    return Err("控制输入行超限".into());
                }
                line.push(byte);
            }
        }
    }
}
fn decode(line: &[u8], epoch: u32) -> Result<Vec<u8>, String> {
    let mut value: serde_json::Value = serde_json::from_slice(line).map_err(|_| "控制JSON无效")?;
    let supplied = value
        .as_object_mut()
        .and_then(|object| object.remove("epoch"))
        .and_then(|value| value.as_u64());
    if supplied != Some(u64::from(epoch)) {
        return Err("控制代次已过期或缺失".into());
    }
    let command: Control = serde_json::from_value(value).map_err(|_| "控制JSON无效")?;
    command.encode()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_control_is_never_replayed() {
        assert_eq!(decode(br#"{"type":"rotate","epoch":2}"#, 2).unwrap(), [11]);
        assert!(decode(br#"{"type":"rotate","epoch":1}"#, 2).is_err());
        assert!(decode(br#"{"type":"rotate"}"#, 2).is_err());
        assert!(decode(br#"{"type":"rotate","epoch":2,"shell":"bad"}"#, 2).is_err());
    }
}
