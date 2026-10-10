mod models;

use crate::{Control, Error, Result, discovery, rules};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) enum Input {
    Discover,
    Packages {
        device_id: String,
    },
    Install {
        device_id: String,
        artifact_id: String,
    },
    Uninstall {
        device_id: String,
        package: String,
    },
}

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    if !value.is_object() {
        return Err(Error::Invalid("设备动作及业务输入必须为对象"));
    }
    serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("设备动作封套或业务字段不符合严格格式"))
}

pub(crate) fn parse(operation: &str, input: &Value) -> Result<Input> {
    if operation == "discover" {
        decode::<models::Empty>(input)?;
        return Ok(Input::Discover);
    }
    if !matches!(operation, "packages" | "app.install" | "app.uninstall") {
        return Err(Error::Invalid("鸿蒙设备插件只接受本批四个短贡献名"));
    }
    if input.get("device_id").is_none() || input.get("input").is_none() {
        return Err(Error::Invalid("设备动作封套必须显式提供device_id和input"));
    }
    let envelope: models::Envelope = decode(input)?;
    rules::serial(&envelope.device_id)?;
    let device_id = envelope.device_id;
    match operation {
        "packages" => {
            decode::<models::Empty>(&envelope.input)?;
            Ok(Input::Packages { device_id })
        }
        "app.install" => {
            let value: models::Artifact = decode(&envelope.input)?;
            rules::artifact_id(&value.artifact_id)?;
            Ok(Input::Install {
                device_id,
                artifact_id: value.artifact_id,
            })
        }
        "app.uninstall" => {
            let value: models::Package = decode(&envelope.input)?;
            rules::package(&value.package)?;
            Ok(Input::Uninstall {
                device_id,
                package: value.package,
            })
        }
        _ => Err(Error::Invalid("鸿蒙设备动作不存在")),
    }
}

pub(crate) async fn execute(control: &Control, input: Input) -> Result<Value> {
    control.check()?;
    match input {
        Input::Discover => {
            let captured = control.capture(&["list".into(), "targets".into()]).await?;
            let stdout = std::str::from_utf8(&captured.stdout)
                .map_err(|_| Error::Dependency("HDC发现输出不是有效UTF-8"))?;
            rules::text(b"", &captured.stderr)?;
            let devices = discovery::parse(stdout)?;
            control.check()?;
            serde_json::to_value(devices).map_err(|_| Error::Dependency("发现结果无法序列化"))
        }
        Input::Packages { device_id } => {
            let args = vec![
                "-t".into(),
                device_id,
                "shell".into(),
                "bm".into(),
                "dump".into(),
                "-a".into(),
            ];
            let captured = control.capture(&args).await?;
            let output = rules::text(&captured.stdout, &captured.stderr)?;
            control.check()?;
            Ok(json!({"output":output}))
        }
        Input::Uninstall { device_id, package } => {
            let args = vec!["-t".into(), device_id, "uninstall".into(), package];
            let captured = control.capture(&args).await?;
            let output = rules::success(&captured.stdout, &captured.stderr, false)?;
            control.check()?;
            Ok(json!({"output":output}))
        }
        Input::Install { .. } => Err(Error::Invalid("安装须进入私有资源流程")),
    }
}

#[cfg(test)]
#[path = "operations/tests.rs"]
mod tests;
