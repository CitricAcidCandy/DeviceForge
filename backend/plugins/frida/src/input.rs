//! 业务输入为结构化封套，禁止自由命令和部署工具路径。
use crate::{Error, Result};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    device_id: String,
    input: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Deploy {
    artifact_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    duration_ms: u64,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScriptMode {
    Spawn,
    Attach,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScriptInput {
    pub package: String,
    pub mode: ScriptMode,
    pub duration_ms: u64,
    pub script_artifact_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Hook {
    pub class: String,
    pub method: String,
    #[serde(default)]
    pub module: String,
    pub action: String,
    pub messages: String,
    #[serde(default)]
    pub args: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PermissionsInput {
    pub package: String,
    pub mode: ScriptMode,
    pub duration_ms: u64,
    #[serde(default)]
    pub modules: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<Hook>,
    #[serde(default = "enabled")]
    pub show_log: bool,
}
fn enabled() -> bool {
    true
}
pub(crate) enum Operation {
    Deploy(String),
    Status,
    Run(u64),
    Processes,
    Script(ScriptInput),
    Permissions(PermissionsInput),
}
pub(crate) struct Input {
    pub device_id: String,
    pub operation: Operation,
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::Invalid("业务字段缺失、类型错误或含额外字段"))
}
pub(crate) fn text(value: &str, maximum: usize) -> Result<()> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(Error::Invalid("字符串为空、超限或含控制符"));
    }
    Ok(())
}
pub(crate) fn duration(value: u64) -> Result<()> {
    if !(100..=120_000).contains(&value) {
        return Err(Error::Invalid("时长须为100至120000毫秒"));
    }
    Ok(())
}
fn package(value: &str) -> Result<()> {
    text(value, 255)?;
    if !value.contains('.')
        || !value.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
    {
        return Err(Error::Invalid("应用包名格式错误"));
    }
    Ok(())
}
pub(crate) fn parse(operation: &str, value: &Value) -> Result<Input> {
    let envelope: Envelope = decode(value.clone())?;
    text(&envelope.device_id, 255)?;
    if !envelope
        .device_id
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        || !envelope
            .device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(Error::Invalid("设备标识格式错误"));
    }
    let operation = match operation {
        "server.deploy" => {
            let v: Deploy = decode(envelope.input)?;
            text(&v.artifact_id, 128)?;
            Operation::Deploy(v.artifact_id)
        }
        "server.status" => {
            decode::<Empty>(envelope.input)?;
            Operation::Status
        }
        "processes" => {
            decode::<Empty>(envelope.input)?;
            Operation::Processes
        }
        "server.run" => {
            let v: Run = decode(envelope.input)?;
            duration(v.duration_ms)?;
            Operation::Run(v.duration_ms)
        }
        "script.run" => {
            let v: ScriptInput = decode(envelope.input)?;
            package(&v.package)?;
            duration(v.duration_ms)?;
            text(&v.script_artifact_id, 128)?;
            Operation::Script(v)
        }
        "permissions.analyze" => {
            let v: PermissionsInput = decode(envelope.input)?;
            package(&v.package)?;
            duration(v.duration_ms)?;
            if v.modules.len() > 11 || v.hooks.len() > 256 {
                return Err(Error::TooLarge);
            }
            for module in &v.modules {
                if ![
                    "permissions",
                    "phone",
                    "system",
                    "packages",
                    "location",
                    "camera",
                    "network",
                    "bluetooth",
                    "files",
                    "media",
                    "sensor",
                ]
                .contains(&module.as_str())
                {
                    return Err(Error::Invalid("权限模块不受支持"));
                }
            }
            if v.modules
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != v.modules.len()
            {
                return Err(Error::Invalid("权限模块不能重复"));
            }
            for hook in &v.hooks {
                text(&hook.class, 255)?;
                text(&hook.method, 255)?;
                if !hook
                    .class
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._$".contains(&b))
                    || !hook
                        .method
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_$".contains(&b))
                {
                    return Err(Error::Invalid("Hook类名或方法名格式错误"));
                }
                text(&hook.action, 512)?;
                text(&hook.messages, 2048)?;
                if hook.module.len() > 255 || hook.args.len() > 32 {
                    return Err(Error::TooLarge);
                }
                if !hook.module.is_empty() {
                    text(&hook.module, 255)?;
                }
                for arg in &hook.args {
                    text(arg, 2048)?;
                }
            }
            Operation::Permissions(v)
        }
        _ => return Err(Error::Invalid("未知Frida贡献")),
    };
    Ok(Input {
        device_id: envelope.device_id,
        operation,
    })
}
