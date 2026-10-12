//! 使用部署者Frida CLI执行加载、附加或派生；结果来自实际CLI输出。
use crate::{Error, Result, config::Config, control::Control, files, input::ScriptMode};
use serde_json::{Value, json};
use std::path::Path;

pub(crate) struct ScriptResult {
    pub value: Value,
    pub log: Vec<u8>,
    pub notices: Vec<u8>,
}
pub(crate) struct ScriptCall<'a> {
    pub package: &'a str,
    pub mode: ScriptMode,
    pub duration_ms: u64,
    pub path: &'a Path,
}
pub(crate) async fn run(
    control: &Control,
    config: &Config,
    device: &str,
    call: ScriptCall<'_>,
    directory: &Path,
) -> Result<ScriptResult> {
    let ScriptCall {
        package,
        mode,
        duration_ms,
        path,
    } = call;
    let timeout = duration_ms.div_ceil(1000);
    let mode_name = match mode {
        ScriptMode::Spawn => "spawn",
        ScriptMode::Attach => "attach",
    };
    let selector = match mode {
        ScriptMode::Spawn => "-f",
        ScriptMode::Attach => "-n",
    };
    let args = vec![
        "-D".into(),
        device.into(),
        selector.into(),
        package.into(),
        "-l".into(),
        path.to_str()
            .ok_or(Error::Invalid("脚本路径须为UTF-8"))?
            .into(),
        "-q".into(),
        "--timeout".into(),
        timeout.to_string(),
        "--exit-on-error".into(),
    ];
    let output = control
        .capture(&config.tools.frida, &args, None, Some(directory), false)
        .await?;
    let text =
        std::str::from_utf8(&output.stdout).map_err(|_| Error::Tool("CLI输出不是UTF-8".into()))?;
    let mut notices = Vec::new();
    let mut count = 0;
    let mut summary = Vec::new();
    for line in text.lines() {
        if let Some((_, raw)) = line.split_once("__DEVICEFORGE_NOTICE__") {
            let notice: Value =
                serde_json::from_str(raw).map_err(|_| Error::Tool("notice不是有效JSON".into()))?;
            if notice.get("type").and_then(Value::as_str) != Some("notice") {
                return Err(Error::Tool("notice类型无效".into()));
            }
            count += 1;
            if count > 10000 {
                return Err(Error::TooLarge);
            }
            notices.extend_from_slice(raw.as_bytes());
            notices.push(b'\n');
        }
        if let Some((_, raw)) = line.split_once("__DEVICEFORGE_HOOK__") {
            let entry: Value = serde_json::from_str(raw)
                .map_err(|_| Error::Tool("Hook诊断不是有效JSON".into()))?;
            if summary.len() > 4096 {
                return Err(Error::TooLarge);
            }
            summary.push(entry);
        }
    }
    let mut log = output.stdout;
    log.extend_from_slice(b"\n");
    log.extend(output.stderr);
    Ok(ScriptResult {
        value: json!({"package":package,"mode":mode_name,"duration_requested_ms":duration_ms,"cli_timeout_seconds":timeout,
            "loaded":true,"resume":if matches!(mode,ScriptMode::Spawn) {"cli_default"} else {"already_running"},
            "notice_count":count,"hook_summary":summary,"cleanup":"direct_cli_confirmed","target_process_cleanup":"not_claimed"}),
        log,
        notices,
    })
}
pub(crate) async fn contents(control: &Control, path: &Path) -> Result<Vec<u8>> {
    let path = path.to_owned();
    control
        .work(move |context, _| {
            files::read(&path, files::FILE_LIMIT, || {
                context.check().map_err(Into::into)
            })
        })
        .await
}
