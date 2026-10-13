mod execution;
mod models;
mod observation;
mod receipt;
mod rules;
mod scripts;

use crate::{Control, Error, Result};
use models::{Action, Business};
use serde_json::{Value, json};

pub(crate) use observation::observe_devices;

#[derive(Debug)]
pub(crate) struct Input {
    device_id: String,
    action: Action,
}

pub(crate) fn parse(device_id: String, input: &Value) -> Result<Input> {
    crate::rules::serial(&device_id)?;
    if !input.is_object() || !input.get("action").is_some_and(Value::is_object) {
        return Err(Error::Invalid("Harmony输入和action须为显式对象"));
    }
    let business: Business = serde_json::from_value(input.clone())
        .map_err(|_| Error::Invalid("Harmony输入动作字段不符合严格格式"))?;
    rules::validate(&business.action)?;
    Ok(Input {
        device_id,
        action: business.action,
    })
}

pub(crate) async fn qualify(control: &Control, device_id: &str) -> Result<()> {
    qualify_until(control, device_id, None).await.map(|_| ())
}

async fn qualify_until(
    control: &Control,
    device_id: &str,
    admission_until: Option<tokio::time::Instant>,
) -> Result<bool> {
    control.check()?;
    if admission_until.is_some_and(|until| tokio::time::Instant::now() >= until) {
        return Ok(false);
    }
    let token = scripts::token()?;
    let version = execution::run(control, device_id, &token, "version", "uitest --version").await?;
    receipt::version(&version.body)?;
    control.check()?;
    if admission_until.is_some_and(|until| tokio::time::Instant::now() >= until) {
        return Ok(false);
    }
    let help = execution::run(control, device_id, &token, "help", "uitest help").await?;
    receipt::help(&help.body)?;
    control.check()?;
    Ok(true)
}

pub(crate) async fn execute(control: &Control, input: Input) -> Result<Value> {
    control.check()?;
    rules::validate(&input.action)?;
    qualify(control, &input.device_id).await?;
    let token = scripts::token()?;
    let command = scripts::action(&input.action)?;
    let result = execution::run(control, &input.device_id, &token, "action", &command).await?;
    receipt::success(&result.body)?;
    if input.action.enter() {
        control.check()?;
        let result = execution::run(
            control,
            &input.device_id,
            &token,
            "enter",
            "uitest uiInput keyEvent 2054",
        )
        .await?;
        receipt::success(&result.body)?;
    }
    control.check()?;
    Ok(json!({
        "device_id": input.device_id,
        "action": input.action.kind(),
        "dispatched": true,
    }))
}

#[cfg(test)]
mod tests;
