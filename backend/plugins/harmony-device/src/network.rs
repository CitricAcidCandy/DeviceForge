mod models;
mod rules;

use crate::{Control, Error, Result};
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) enum Input {
    Connect { address: String },
    Disconnect { address: String },
}

pub(crate) fn parse(operation: &str, input: &Value) -> Result<Input> {
    if !input.is_object() {
        return Err(Error::Invalid("连接管理业务输入必须为对象"));
    }
    let value: models::Address = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("连接管理业务字段不符合严格格式"))?;
    rules::address(&value.address)?;
    match operation {
        "connect" => Ok(Input::Connect {
            address: value.address,
        }),
        "disconnect" => Ok(Input::Disconnect {
            address: value.address,
        }),
        _ => Err(Error::Invalid("鸿蒙设备插件不存在该连接管理动作")),
    }
}

pub(crate) async fn execute(control: &Control, input: Input) -> Result<Value> {
    control.check()?;
    let (args, disconnect) = match input {
        Input::Connect { address } => (vec!["tconn".into(), address], false),
        Input::Disconnect { address } => (vec!["tconn".into(), address, "-remove".into()], true),
    };
    let captured = control.capture(&args).await?;
    let output = if disconnect {
        rules::disconnect(&captured.stdout, &captured.stderr)?
    } else {
        rules::connect(&captured.stdout, &captured.stderr)?
    };
    control.check()?;
    Ok(json!({"output":output}))
}

#[cfg(test)]
#[path = "network/tests.rs"]
mod tests;
