//! 单次动作的固定argv和输出资格；不接收自由工具参数。
use super::Input;
use crate::{Error, Result, rules};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) struct Command {
    pub args: Vec<String>,
    pub short_limit: Option<Duration>,
    response: Response,
}

enum Response {
    Connect,
    Ordinary,
    Packages,
    Uninstall,
}

pub(super) fn plan(input: &Input) -> Option<Command> {
    let (args, response, short_limit) = match input {
        Input::Connect { address } => (
            vec!["connect".into(), address.clone()],
            Response::Connect,
            Some(Duration::from_millis(5000)),
        ),
        Input::Disconnect { address } => (
            vec!["disconnect".into(), address.clone()],
            Response::Ordinary,
            None,
        ),
        Input::Packages { device_id } => (
            device_args(device_id, &["shell", "pm", "list", "packages"]),
            Response::Packages,
            None,
        ),
        Input::Start { device_id, package } => (
            device_args(
                device_id,
                &[
                    "shell",
                    "monkey",
                    "-p",
                    package,
                    "-c",
                    "android.intent.category.LAUNCHER",
                    "1",
                ],
            ),
            Response::Ordinary,
            None,
        ),
        Input::Stop { device_id, package } => (
            device_args(device_id, &["shell", "am", "force-stop", package]),
            Response::Ordinary,
            None,
        ),
        Input::Uninstall { device_id, package } => (
            device_args(device_id, &["uninstall", package]),
            Response::Uninstall,
            None,
        ),
        Input::Discover | Input::Action { .. } => return None,
    };
    Some(Command {
        args,
        response,
        short_limit,
    })
}

fn device_args(serial: &str, tail: &[&str]) -> Vec<String> {
    let mut args = vec!["-s".into(), serial.to_owned()];
    args.extend(tail.iter().map(|part| (*part).to_owned()));
    args
}

impl Command {
    pub(super) fn result(&self, output: &str) -> Result<Value> {
        let output = output.trim();
        let lower = output.to_ascii_lowercase();
        let valid = match self.response {
            Response::Packages => !output.lines().any(rules::adb_diagnostic_line),
            Response::Connect => {
                !ordinary_failure(&lower)
                    && (lower.starts_with("connected to ")
                        || lower.starts_with("already connected to "))
            }
            Response::Ordinary => !ordinary_failure(&lower),
            Response::Uninstall => {
                ![
                    "failure",
                    "failed",
                    "error",
                    "unable",
                    "cannot",
                    "offline",
                    "no devices",
                ]
                .iter()
                .any(|word| lower.contains(word))
                    && output.lines().any(|line| line.trim() == "Success")
            }
        };
        if !valid {
            return Err(Error::Dependency("ADB动作未满足成功响应条件"));
        }
        Ok(json!({"output": output}))
    }
}

fn ordinary_failure(output: &str) -> bool {
    [
        "failed",
        "unable",
        "cannot",
        "error:",
        "no devices",
        "device offline",
        "monkey aborted",
        "no activities",
    ]
    .iter()
    .any(|word| output.contains(word))
}
