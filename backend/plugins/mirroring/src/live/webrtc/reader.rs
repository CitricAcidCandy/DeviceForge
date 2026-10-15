use super::media::Packet;
use crate::live::{checked, wire::PAYLOAD_LIMIT};
use deviceforge_plugin_runtime::InvocationContext;
use tokio::{io::AsyncReadExt, net::TcpStream};

pub(super) struct Reader {
    socket: TcpStream,
    header: [u8; 12],
    header_read: usize,
    payload: Vec<u8>,
    payload_read: usize,
    flags: u8,
    pts: u64,
}

impl Reader {
    pub(super) fn new(socket: TcpStream) -> Self {
        Self {
            socket,
            header: [0; 12],
            header_read: 0,
            payload: Vec::new(),
            payload_read: 0,
            flags: 0,
            pts: 0,
        }
    }

    pub(super) async fn next(&mut self, context: &InvocationContext) -> Result<Packet, String> {
        checked(context, self.next_packet()).await
    }

    async fn next_packet(&mut self) -> Result<Packet, String> {
        while self.header_read < self.header.len() {
            let count = self
                .socket
                .read(&mut self.header[self.header_read..])
                .await
                .map_err(|_| "媒体连接读取失败")?;
            if count == 0 {
                return Err("媒体连接已断开或包头已截断".into());
            }
            self.header_read += count;
        }
        if self.payload.is_empty() {
            let packed =
                u64::from_be_bytes(self.header[..8].try_into().map_err(|_| "媒体时间戳无效")?);
            let length =
                u32::from_be_bytes(self.header[8..].try_into().map_err(|_| "媒体长度无效")?)
                    as usize;
            if length == 0 || length > PAYLOAD_LIMIT {
                return Err("媒体载荷无效或超限".into());
            }
            self.flags =
                u8::from(packed & (1 << 62) != 0) | (u8::from(packed & (1 << 63) != 0) << 1);
            if self.flags == 3 {
                return Err("媒体标志无效".into());
            }
            self.pts = packed & ((1 << 62) - 1);
            self.payload = vec![0; length];
        }
        while self.payload_read < self.payload.len() {
            let count = self
                .socket
                .read(&mut self.payload[self.payload_read..])
                .await
                .map_err(|_| "媒体载荷读取失败")?;
            if count == 0 {
                return Err("媒体载荷已截断".into());
            }
            self.payload_read += count;
        }
        let packet = Packet {
            flags: self.flags,
            pts: self.pts,
            data: std::mem::take(&mut self.payload),
        };
        self.header_read = 0;
        self.payload_read = 0;
        Ok(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::{io::AsyncWriteExt, net::TcpListener};

    async fn pair() -> (Reader, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (socket, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        (Reader::new(accepted.unwrap().0), socket.unwrap())
    }

    fn frame(packed: u64, payload: &[u8]) -> Vec<u8> {
        let mut frame = packed.to_be_bytes().to_vec();
        frame.extend((payload.len() as u32).to_be_bytes());
        frame.extend(payload);
        frame
    }

    #[tokio::test]
    async fn keeps_partial_header_and_payload_when_future_is_cancelled() {
        let (mut reader, mut writer) = pair().await;
        let bytes = frame((1 << 62) | 123, b"abcdef");
        writer.write_all(&bytes[..5]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), reader.next_packet())
                .await
                .is_err()
        );
        assert_eq!(reader.header_read, 5);
        writer.write_all(&bytes[5..14]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), reader.next_packet())
                .await
                .is_err()
        );
        assert_eq!(reader.payload_read, 2);
        writer.write_all(&bytes[14..]).await.unwrap();
        let packet = reader.next_packet().await.unwrap();
        assert_eq!((packet.flags, packet.pts), (1, 123));
        assert_eq!(packet.data, b"abcdef");
        writer.write_all(&frame(456, b"next")).await.unwrap();
        let next = reader.next_packet().await.unwrap();
        assert_eq!((next.flags, next.pts), (0, 456));
        assert_eq!(next.data, b"next");
    }

    #[tokio::test]
    async fn rejects_truncation_and_invalid_headers() {
        for (packed, length) in [(0u64, 0u32), (0, PAYLOAD_LIMIT as u32 + 1), (3u64 << 62, 1)] {
            let (mut reader, mut writer) = pair().await;
            let mut header = packed.to_be_bytes().to_vec();
            header.extend(length.to_be_bytes());
            writer.write_all(&header).await.unwrap();
            assert!(reader.next_packet().await.is_err());
        }
        let (mut reader, mut writer) = pair().await;
        writer
            .write_all(&frame(0, b"truncated")[..14])
            .await
            .unwrap();
        writer.shutdown().await.unwrap();
        assert!(reader.next_packet().await.err().unwrap().contains("截断"));
    }
}
