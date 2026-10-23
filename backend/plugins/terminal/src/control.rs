use crate::{Error, Result};
use deviceforge_tool_process::PtySize;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Message {
    Input { text: String },
    Resize { cols: u16, rows: u16 },
}

pub(crate) fn parse(bytes: &[u8]) -> Result<Message> {
    let message: Message = serde_json::from_slice(bytes)
        .map_err(|_| Error::Invalid("终端输入须为完整的input或resize消息"))?;
    if let Message::Resize { cols, rows } = message {
        PtySize::new(cols, rows).map_err(|_| Error::Invalid("终端尺寸超出允许范围"))?;
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_binary_partial_and_out_of_range_messages() {
        for bytes in [
            b"dir".as_slice(),
            b"{\"type\":\"input\",\"text\":\"a\",\"shell\":true}",
            b"{\"type\":\"resize\",\"cols\":0,\"rows\":30}",
            b"{\"type\":\"resize\",\"cols\":80,\"rows\":201}",
            &[255, 0],
        ] {
            assert!(parse(bytes).is_err());
        }
        assert!(matches!(
            parse(r#"{"type":"input","text":"\u0003中文\r"}"#.as_bytes()).unwrap(),
            Message::Input { .. }
        ));
        assert!(parse(br#"{"type":"resize","cols":80,"rows":24}"#).is_ok());
    }
}
