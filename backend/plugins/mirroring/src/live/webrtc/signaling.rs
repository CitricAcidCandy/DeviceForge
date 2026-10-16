use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::session::{SessionInput, SessionOutput};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;

const LINE_LIMIT: usize = 65_536;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Message {
    Answer {
        version: u8,
        epoch: u8,
        sdp: String,
    },
    Control {
        version: u8,
        epoch: u8,
        #[serde(default)]
        control_revision: Option<u64>,
        command: Value,
    },
    ControlRequest {
        version: u8,
        epoch: u8,
        request_id: String,
    },
    ControlRespond {
        version: u8,
        epoch: u8,
        request_id: String,
        client_id: String,
        accept: bool,
    },
    ControlReclaim {
        version: u8,
        epoch: u8,
        request_id: String,
    },
    ControlRelease {
        version: u8,
        epoch: u8,
        request_id: String,
    },
}

pub(super) enum EncodedControl {
    Input {
        bytes: Vec<u8>,
        revision: Option<u64>,
    },
    Ownership {
        request_id: String,
        command: crate::live::ownership::Command,
    },
}

pub(super) fn ownership(
    message: Message,
) -> Result<(String, crate::live::ownership::Command), String> {
    use crate::live::ownership::Command;
    let (request_id, command) = match message {
        Message::ControlRequest {
            version: 1,
            epoch: 1,
            request_id,
        } => (request_id, Command::Request),
        Message::ControlRespond {
            version: 1,
            epoch: 1,
            request_id,
            client_id,
            accept,
        } => (request_id, Command::Respond { client_id, accept }),
        Message::ControlReclaim {
            version: 1,
            epoch: 1,
            request_id,
        } => (request_id, Command::Reclaim),
        Message::ControlRelease {
            version: 1,
            epoch: 1,
            request_id,
        } => (request_id, Command::Release),
        _ => return Err("WebRTC 控制权消息版本或类型无效".into()),
    };
    if request_id.len() != 36
        || !request_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("WebRTC 控制权请求标识无效".into());
    }
    Ok((request_id, command))
}

pub(super) fn control_line(bytes: &[u8]) -> Result<EncodedControl, String> {
    if bytes.is_empty()
        || bytes.len() > 4096
        || !bytes.ends_with(b"\n")
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err("WebRTC 控制行无效或超限".into());
    }
    let message: Message = serde_json::from_slice(bytes).map_err(|_| "WebRTC 控制 JSON 无效")?;
    match message {
        Message::Control {
            version: 1,
            epoch: 1,
            control_revision,
            command,
        } => {
            let command: super::Control =
                serde_json::from_value(command).map_err(|_| "WebRTC 控制命令无效")?;
            Ok(EncodedControl::Input {
                bytes: command.encode()?,
                revision: control_revision,
            })
        }
        message => {
            let (request_id, command) = ownership(message)?;
            Ok(EncodedControl::Ownership {
                request_id,
                command,
            })
        }
    }
}

pub(super) struct Reader {
    line: Vec<u8>,
    pending: VecDeque<u8>,
    answered: bool,
}

impl Reader {
    pub(super) fn new() -> Self {
        Self {
            line: Vec::new(),
            pending: VecDeque::new(),
            answered: false,
        }
    }

    pub(super) async fn next(
        &mut self,
        input: &mut SessionInput,
    ) -> Result<Option<Message>, String> {
        loop {
            if let Some(byte) = self.pending.pop_front() {
                self.line.push(byte);
                if self.line.len() > LINE_LIMIT {
                    return Err("WebRTC 信令行超限".into());
                }
                if byte == b'\n' {
                    let line = std::mem::take(&mut self.line);
                    let message: Message =
                        serde_json::from_slice(&line).map_err(|_| "WebRTC 信令 JSON 无效")?;
                    match &message {
                        Message::Answer {
                            version,
                            epoch,
                            sdp,
                        } => {
                            if *version != 1 || *epoch != 1 || self.answered || sdp.is_empty() {
                                return Err("WebRTC answer 版本、代次或顺序无效".into());
                            }
                            self.answered = true;
                        }
                        Message::Control { version, epoch, .. } => {
                            if *version != 1 || *epoch != 1 || !self.answered || line.len() > 4096 {
                                return Err("WebRTC 控制版本、代次、顺序或长度无效".into());
                            }
                        }
                        Message::ControlRequest { version, epoch, .. }
                        | Message::ControlRespond { version, epoch, .. }
                        | Message::ControlReclaim { version, epoch, .. }
                        | Message::ControlRelease { version, epoch, .. } => {
                            if *version != 1 || *epoch != 1 || !self.answered || line.len() > 4096 {
                                return Err("WebRTC 控制权版本、代次或顺序无效".into());
                            }
                        }
                    }
                    return Ok(Some(message));
                }
            } else {
                let chunk = input.recv().await.map_err(|error| error.to_string())?;
                let Some(chunk) = chunk else {
                    if !self.line.is_empty() {
                        return Err("WebRTC 信令末行缺少换行".into());
                    }
                    return Ok(None);
                };
                self.pending.extend(chunk);
            }
        }
    }
}

pub(super) async fn send(output: &SessionOutput, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "WebRTC 信令编码失败")?;
    bytes.push(b'\n');
    if bytes.len() > LINE_LIMIT {
        return Err("WebRTC 输出信令行超限".into());
    }
    for chunk in bytes.chunks(8192) {
        output
            .send(SessionStream::Stdout, chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) async fn status(output: &SessionOutput, state: &str) -> Result<(), String> {
    send(
        output,
        json!({"version":1,"epoch":1,"type":"status","state":state}),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_message_fields() {
        assert!(
            serde_json::from_str::<Message>(
                r#"{"type":"answer","version":1,"epoch":1,"sdp":"offer","extra":1}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Message>(
                r#"{"type":"control","version":1,"epoch":1,"command":{"type":"rotate"}}"#
            )
            .is_ok()
        );
    }

    #[test]
    fn data_channel_accepts_ownership_requests_and_keeps_input_revision() {
        let message = control_line(b"{\"version\":1,\"epoch\":1,\"type\":\"control_request\",\"request_id\":\"12345678-1234-1234-1234-123456789abc\"}\n").unwrap();
        assert!(matches!(
            message,
            EncodedControl::Ownership {
                command: crate::live::ownership::Command::Request,
                ..
            }
        ));
        let message = control_line(b"{\"version\":1,\"epoch\":1,\"type\":\"control\",\"control_revision\":7,\"command\":{\"type\":\"rotate\"}}\n").unwrap();
        assert!(
            matches!(message, EncodedControl::Input { bytes, revision: Some(7) } if bytes == [11])
        );
        assert!(control_line(b"{\"version\":1,\"epoch\":1,\"type\":\"control_reclaim\",\"request_id\":\"invalid\"}\n").is_err());
    }
}
