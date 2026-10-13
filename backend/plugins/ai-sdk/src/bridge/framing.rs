use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

pub const FRAME_LIMIT: usize = 64 * 1024;
pub const CHUNK_LIMIT: usize = 8192;
pub const QUEUE_LIMIT: usize = 32;
pub const IPC_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Coordinator,
    Worker,
    Proxy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub format_version: u32,
    pub call_id: String,
    pub nonce: String,
    pub role: Role,
    pub sequence: u32,
    pub payload: Value,
}

pub struct Codec {
    call_id: String,
    nonce: String,
    sender: Role,
    receiver: Role,
    sent: u32,
    received: u32,
}

impl Codec {
    pub fn new(
        call_id: String,
        nonce: String,
        sender: Role,
        receiver: Role,
    ) -> Result<Self, String> {
        if call_id.is_empty()
            || call_id.len() > 64
            || nonce.len() != 64
            || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || sender == receiver
        {
            return Err("SDK私有传输身份无效".into());
        }
        Ok(Self {
            call_id,
            nonce,
            sender,
            receiver,
            sent: 0,
            received: 0,
        })
    }

    pub fn encode(&mut self, payload: Value) -> Result<Vec<u8>, String> {
        let sequence = self.sent.checked_add(1).ok_or("SDK私有发送序号已耗尽")?;
        if !payload.is_object() {
            return Err("SDK私有负载须为对象".into());
        }
        let frame = Frame {
            format_version: IPC_VERSION,
            call_id: self.call_id.clone(),
            nonce: self.nonce.clone(),
            role: self.sender,
            sequence,
            payload,
        };
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| "SDK私有帧序列化失败")?;
        if bytes.len() >= FRAME_LIMIT {
            return Err("SDK私有帧超过64KiB".into());
        }
        bytes.push(b'\n');
        self.sent = sequence;
        Ok(bytes)
    }

    pub fn decode(&mut self, bytes: &[u8]) -> Result<Value, String> {
        if bytes.len() > FRAME_LIMIT || bytes.last() != Some(&b'\n') {
            return Err("SDK私有帧不完整或超限".into());
        }
        let frame: Frame = serde_json::from_slice(bytes).map_err(|_| "SDK私有帧JSON无效")?;
        let sequence = self
            .received
            .checked_add(1)
            .ok_or("SDK私有接收序号已耗尽")?;
        if frame.format_version != IPC_VERSION
            || frame.call_id != self.call_id
            || frame.nonce != self.nonce
            || frame.role != self.receiver
            || frame.sequence != sequence
            || !frame.payload.is_object()
        {
            return Err("SDK私有帧身份、角色或序号不匹配".into());
        }
        self.received = sequence;
        Ok(frame.payload)
    }

    pub async fn read<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> Result<Option<Value>, String> {
        let mut bytes = Vec::new();
        loop {
            let available = reader.fill_buf().await.map_err(|_| "SDK私有帧读取失败")?;
            if available.is_empty() {
                return if bytes.is_empty() {
                    Ok(None)
                } else {
                    Err("SDK私有帧EOF前不完整".into())
                };
            }
            let complete = available.iter().position(|byte| *byte == b'\n');
            let count = complete.map_or(available.len(), |position| position + 1);
            if count > FRAME_LIMIT.saturating_sub(bytes.len()) {
                return Err("SDK私有帧超过64KiB".into());
            }
            bytes.extend_from_slice(&available[..count]);
            reader.consume(count);
            if complete.is_some() {
                return self.decode(&bytes).map(Some);
            }
        }
    }

    pub async fn write<W: AsyncWrite + Unpin>(
        &mut self,
        writer: &mut W,
        payload: Value,
    ) -> Result<(), String> {
        let bytes = self.encode(payload)?;
        writer
            .write_all(&bytes)
            .await
            .map_err(|_| "SDK私有帧写入失败")?;
        writer.flush().await.map_err(|_| "SDK私有帧刷新失败".into())
    }
}

pub fn bytes(payload: &Value) -> Result<Vec<u8>, String> {
    let values = payload
        .get("bytes")
        .and_then(Value::as_array)
        .ok_or("SDK私有字节块无效")?;
    if values.len() > CHUNK_LIMIT {
        return Err("SDK私有字节块超过8KiB".into());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|number| u8::try_from(number).ok())
                .ok_or_else(|| "SDK私有字节块含非字节数值".into())
        })
        .collect()
}

#[cfg(test)]
#[path = "framing_tests.rs"]
mod tests;
