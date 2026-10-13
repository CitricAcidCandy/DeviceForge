mod details;
mod models;
mod rules;

use crate::{Control, Error, Result, rules as common_rules};
use models::{Bundle, Start, object};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) enum Input {
    Detail {
        device_id: String,
        bundle: String,
    },
    Start {
        device_id: String,
        bundle: String,
        ability: Option<String>,
    },
    Stop {
        device_id: String,
        bundle: String,
    },
    Reset {
        device_id: String,
        bundle: String,
    },
}

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    object(value)?;
    serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("应用动作业务字段不符合严格格式"))
}

pub(crate) fn parse(operation: &str, device_id: String, input: &Value) -> Result<Input> {
    let bundle = match operation {
        "app.start" => {
            if input.get("ability").is_some_and(|value| !value.is_string()) {
                return Err(Error::Invalid("Ability字段必须为字符串"));
            }
            let value: Start = decode(input)?;
            common_rules::package(&value.bundle)?;
            if let Some(ability) = value.ability.as_deref() {
                rules::ability(ability)?;
            }
            return Ok(Input::Start {
                device_id,
                bundle: value.bundle,
                ability: value.ability,
            });
        }
        "app.detail" | "app.stop" | "app.reset" => decode::<Bundle>(input)?.bundle,
        _ => return Err(Error::Invalid("鸿蒙设备插件不存在该应用动作")),
    };
    common_rules::package(&bundle)?;
    Ok(match operation {
        "app.detail" => Input::Detail { device_id, bundle },
        "app.stop" => Input::Stop { device_id, bundle },
        "app.reset" => Input::Reset { device_id, bundle },
        _ => unreachable!(),
    })
}

pub(crate) async fn execute(control: &Control, input: Input) -> Result<Value> {
    control.check()?;
    let (command, expected) = match input {
        Input::Detail { device_id, bundle } => {
            let value = query_detail(control, device_id, bundle).await?;
            control.check()?;
            return Ok(value);
        }
        Input::Start {
            device_id,
            bundle,
            ability,
        } => {
            let ability = match ability {
                Some(ability) => ability,
                None => {
                    let value = query_detail(control, device_id.clone(), bundle.clone()).await?;
                    details::ability(&value, &bundle)?
                }
            };
            let args = vec![
                "-t".into(),
                device_id.clone(),
                "shell".into(),
                "aa".into(),
                "start".into(),
                "-a".into(),
                ability,
                "-b".into(),
                bundle.clone(),
            ];
            (args, "start ability successfully")
        }
        Input::Stop { device_id, bundle } => (
            vec![
                "-t".into(),
                device_id,
                "shell".into(),
                "aa".into(),
                "force-stop".into(),
                bundle,
            ],
            "force stop process successfully.",
        ),
        Input::Reset { device_id, bundle } => (
            vec![
                "-t".into(),
                device_id,
                "shell".into(),
                "bm".into(),
                "clean".into(),
                "-d".into(),
                "-n".into(),
                bundle,
            ],
            "clean bundle data files successfully.",
        ),
    };
    let captured = control.capture(&command).await?;
    let output = rules::success_line(&captured.stdout, &captured.stderr, expected)?;
    control.check()?;
    Ok(json!({"output":output}))
}

async fn query_detail(control: &Control, device_id: String, bundle: String) -> Result<Value> {
    let args = vec![
        "-t".into(),
        device_id,
        "shell".into(),
        "bm".into(),
        "dump".into(),
        "-n".into(),
        bundle.clone(),
    ];
    let captured = control.capture(&args).await?;
    control
        .work(move |_| details::parse(&captured.stdout, &captured.stderr, &bundle))
        .await
}

#[cfg(test)]
#[path = "applications/tests.rs"]
mod tests;
