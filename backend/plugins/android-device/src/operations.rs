//! 短贡献到业务输入与工具调用的薄编排，不读取部署配置或管理共享daemon。
mod commands;
mod models;

use crate::{Control, Error, Result, discovery, rules};
use rules::Action;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) enum Input {
    Discover,
    Connect { address: String },
    Disconnect { address: String },
    Packages { device_id: String },
    Start { device_id: String, package: String },
    Stop { device_id: String, package: String },
    Uninstall { device_id: String, package: String },
    Action { device_id: String, action: Action },
}

pub(crate) fn parse(operation: &str, input: &Value) -> Result<Input> {
    if operation == "discover" {
        decode::<models::Empty>(input)?;
        return Ok(Input::Discover);
    }
    if !matches!(
        operation,
        "connect"
            | "disconnect"
            | "packages"
            | "app.start"
            | "app.stop"
            | "app.uninstall"
            | "input"
    ) {
        return Err(Error::Invalid("设备插件只接受本批八个短贡献名"));
    }
    if input.get("device_id").is_none() || input.get("input").is_none() {
        return Err(Error::Invalid("设备动作封套必须显式提供device_id和input"));
    }
    let envelope: models::Envelope = decode(input)?;
    if matches!(operation, "connect" | "disconnect") {
        if !envelope.device_id.is_null() {
            return Err(Error::Invalid("提供者动作的device_id必须为显式null"));
        }
        let value: models::Address = decode(&envelope.input)?;
        rules::address(&value.address)?;
        return Ok(if operation == "connect" {
            Input::Connect {
                address: value.address,
            }
        } else {
            Input::Disconnect {
                address: value.address,
            }
        });
    }
    let device_id = envelope
        .device_id
        .as_str()
        .ok_or(Error::Invalid("设备动作的device_id必须为字符串"))?
        .to_owned();
    rules::serial(&device_id)?;
    match operation {
        "packages" => {
            decode::<models::Empty>(&envelope.input)?;
            Ok(Input::Packages { device_id })
        }
        "input" => {
            let value: models::InputAction = decode(&envelope.input)?;
            value.action.validate()?;
            Ok(Input::Action {
                device_id,
                action: value.action,
            })
        }
        _ => {
            let value: models::Package = decode(&envelope.input)?;
            rules::package(&value.package)?;
            Ok(match operation {
                "app.start" => Input::Start {
                    device_id,
                    package: value.package,
                },
                "app.stop" => Input::Stop {
                    device_id,
                    package: value.package,
                },
                "app.uninstall" => Input::Uninstall {
                    device_id,
                    package: value.package,
                },
                _ => return Err(Error::Invalid("设备动作不存在")),
            })
        }
    }
}

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    if !value.is_object() {
        return Err(Error::Invalid("设备动作及业务输入必须为对象"));
    }
    serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("设备动作封套或业务字段不符合严格格式"))
}

pub(crate) async fn execute(control: &Control, input: Input) -> Result<Value> {
    control.check()?;
    let value = match input {
        Input::Discover => {
            let args = vec!["devices".into(), "-l".into()];
            let output = control.capture(&args, None).await?;
            let devices = discovery::parse(text(&output.stdout)?)?;
            serde_json::to_value(devices).map_err(|_| Error::Dependency("设备发现结果无法编码"))?
        }
        Input::Action { device_id, action } => {
            for command in action.commands() {
                control.check()?;
                let mut args = vec![
                    "-s".into(),
                    device_id.clone(),
                    "shell".into(),
                    "-T".into(),
                    "input".into(),
                ];
                args.extend(command);
                let output = control.capture(&args, None).await?;
                let stdout = text(&output.stdout)?;
                let stderr = text(&output.stderr)?;
                if !stdout.trim().is_empty() || !stderr.trim().is_empty() {
                    return Err(Error::Dependency("设备输入命令未返回空响应"));
                }
            }
            json!({"device_id": device_id, "action": action.kind(), "dispatched": true})
        }
        other => {
            let command =
                commands::plan(&other).ok_or(Error::Invalid("设备动作无法生成固定命令"))?;
            control.check()?;
            let output = control.capture(&command.args, command.short_limit).await?;
            command.result(text(&output.stdout)?)?
        }
    };
    control.check()?;
    Ok(value)
}

fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| Error::Dependency("ADB输出不是有效UTF-8文本"))
}

#[cfg(test)]
#[path = "operations/tests.rs"]
mod tests;
