//! Frida CLI 真实进程枚举，格式错误时拒绝猜测。
use crate::{Error, Result, config::Config, control::Control};
use serde_json::{Value, json};
pub(crate) async fn enumerate(
    control: &Control,
    config: &Config,
    device: &str,
) -> Result<(Value, Vec<u8>)> {
    let args = vec!["-D".into(), device.into(), "--json".into()];
    let output = control
        .capture(&config.tools.frida_ps, &args, None, None, false)
        .await?;
    let entries: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| Error::Tool("frida-ps --json未返回JSON".into()))?;
    let entries = entries
        .as_array()
        .ok_or(Error::Tool("frida-ps结果必须为数组".into()))?;
    if entries.len() > 65536 {
        return Err(Error::TooLarge);
    }
    let mut processes = Vec::new();
    for entry in entries {
        let pid = entry
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|p| *p > 0 && *p <= u32::MAX as u64)
            .ok_or(Error::Tool("进程PID无效".into()))?;
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .ok_or(Error::Tool("进程名称缺失".into()))?;
        crate::input::text(name, 4096)?;
        processes.push(json!({"pid":pid,"name":name}));
    }
    let mut log = output.stdout;
    log.extend_from_slice(b"\n");
    log.extend(output.stderr);
    Ok((
        json!({"source":"frida-ps --json","processes":processes}),
        log,
    ))
}
