use std::str;

pub(crate) const CLIPBOARD_TEXT_LIMIT: usize = (1 << 18) - 5;
const FRAME_LIMIT: usize = 1 << 18;

pub(crate) enum DeviceMessage {
    Clipboard(String),
    ClipboardAck(u64),
    Uhid,
}

pub(crate) struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    pub(crate) fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<DeviceMessage>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        while let Some(message) = self.next()? {
            messages.push(message);
        }
        if self.buffer.len() > FRAME_LIMIT {
            return Err("设备控制消息超限".into());
        }
        Ok(messages)
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err("设备控制消息截断".into())
        }
    }

    fn next(&mut self) -> Result<Option<DeviceMessage>, String> {
        let Some(&kind) = self.buffer.first() else {
            return Ok(None);
        };
        let frame_len = match kind {
            0 => {
                if self.buffer.len() < 5 {
                    return Ok(None);
                }
                let length = u32::from_be_bytes(
                    self.buffer[1..5]
                        .try_into()
                        .map_err(|_| "设备控制消息无效")?,
                ) as usize;
                if length > CLIPBOARD_TEXT_LIMIT {
                    return Err("设备剪贴板消息超限".into());
                }
                5 + length
            }
            1 => 9,
            2 => {
                if self.buffer.len() < 5 {
                    return Ok(None);
                }
                let length = u16::from_be_bytes(
                    self.buffer[3..5]
                        .try_into()
                        .map_err(|_| "设备控制消息无效")?,
                ) as usize;
                5 + length
            }
            _ => return Err("设备控制消息类型无效".into()),
        };
        if frame_len > FRAME_LIMIT {
            return Err("设备控制消息超限".into());
        }
        if self.buffer.len() < frame_len {
            return Ok(None);
        }
        let frame: Vec<u8> = self.buffer.drain(..frame_len).collect();
        match kind {
            0 => {
                let text = str::from_utf8(&frame[5..])
                    .map_err(|_| "设备剪贴板文本不是有效UTF-8")?
                    .to_owned();
                if text.as_bytes().contains(&0) {
                    return Err("设备剪贴板文本无效".into());
                }
                Ok(Some(DeviceMessage::Clipboard(text)))
            }
            1 => {
                let sequence =
                    u64::from_be_bytes(frame[1..9].try_into().map_err(|_| "设备控制消息无效")?);
                Ok(Some(DeviceMessage::ClipboardAck(sequence)))
            }
            2 => Ok(Some(DeviceMessage::Uhid)),
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fragmented_clipboard_and_ack() {
        let mut decoder = Decoder::new();
        let mut frame = vec![0];
        frame.extend_from_slice(&("你好".len() as u32).to_be_bytes());
        frame.extend_from_slice("你好".as_bytes());
        frame.extend_from_slice(&[1]);
        frame.extend_from_slice(&9_u64.to_be_bytes());
        let mut messages = Vec::new();
        for chunk in frame.chunks(2) {
            messages.extend(decoder.push(chunk).unwrap());
        }
        assert!(decoder.finish().is_ok());
        assert!(matches!(&messages[0], DeviceMessage::Clipboard(text) if text == "你好"));
        assert!(matches!(messages[1], DeviceMessage::ClipboardAck(9)));
    }

    #[test]
    fn parses_uhid_and_rejects_unknown_or_truncated() {
        let mut decoder = Decoder::new();
        assert!(matches!(
            decoder.push(&[2, 0, 7, 0, 2, 1, 2]).unwrap()[0],
            DeviceMessage::Uhid
        ));
        assert!(decoder.push(&[7]).is_err());
        let mut decoder = Decoder::new();
        decoder.push(&[0, 0, 0]).unwrap();
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn rejects_invalid_utf8_and_oversized_text() {
        let mut decoder = Decoder::new();
        assert!(decoder.push(&[0, 0, 0, 0, 1, 0xff]).is_err());
        let mut decoder = Decoder::new();
        let mut frame = vec![0];
        frame.extend_from_slice(&((CLIPBOARD_TEXT_LIMIT + 1) as u32).to_be_bytes());
        assert!(decoder.push(&frame).is_err());
        let mut decoder = Decoder::new();
        assert!(decoder.push(&[0, 0, 0, 0, 1, 0]).is_err());
    }
}
