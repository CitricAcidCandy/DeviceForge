use apk_plugin_sdk::{PROTOCOL_VERSION, Request, Response};
use std::io::{Read, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err("请求超过 256 KiB".into());
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    let (result, error) = if request.protocol_version != PROTOCOL_VERSION {
        (None, Some("协议版本不兼容".into()))
    } else if request.operation != "echo" {
        (None, Some("未知操作".into()))
    } else {
        (Some(request.input), None)
    };
    let response = Response {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        result,
        error,
        outputs: Vec::new(),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
