//! 只在启动命令失败后进行有界只读辨因，不重放写操作、不透出原始诊断。
use super::{Input, commands, text};
use crate::{Control, Error, Result, rules};
use deviceforge_tool_process::Output;
use serde_json::Value;
use std::time::Duration;
use tokio::time::Instant;

pub(super) async fn execute(
    control: &Control,
    device_id: String,
    package: String,
) -> Result<Value> {
    let command = commands::plan(&Input::Start {
        device_id: device_id.clone(),
        package: package.clone(),
    })
    .ok_or(Error::Invalid("设备动作无法生成固定命令"))?;
    match control.capture(&command.args, command.short_limit).await {
        Ok(output) => command.result(text(&output.stdout)?),
        Err(original @ Error::Dependency(_)) => {
            diagnose(control, &device_id, &package, original).await
        }
        Err(error) => Err(error),
    }
}

async fn diagnose(
    control: &Control,
    device_id: &str,
    package: &str,
    original: Error,
) -> Result<Value> {
    // 两次只读查询共用两秒上限，Control 仍保留原调用的更短期限与取消。
    let deadline = Instant::now() + Duration::from_secs(2);
    let args = [
        "-s", device_id, "shell", "pm", "list", "packages", "--user", "current", package,
    ]
    .map(str::to_owned);
    let Some(output) = read_only(control, &args, deadline).await? else {
        return Err(original);
    };
    match std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|output| installed(output, package))
    {
        Some(false) => {
            return Err(Error::Application(
                "当前设备未安装此应用，请选择已安装应用，或先完成安装",
            ));
        }
        Some(true) => {}
        None => return Err(original),
    }
    let args = [
        "-s",
        device_id,
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        "--user",
        "current",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-p",
        package,
    ]
    .map(str::to_owned);
    let Some(output) = read_only(control, &args, deadline).await? else {
        return Err(original);
    };
    let Ok(activity) = std::str::from_utf8(&output.stdout) else {
        return Err(original);
    };
    if activity.trim() == "No activity found" {
        return Err(Error::Application(
            "此应用没有可用的桌面启动入口，请检查应用是否被停用或需从其他应用打开",
        ));
    }
    if activity.lines().any(|line| {
        line.trim()
            .split_once('/')
            .is_some_and(|(owner, entry)| owner == package && !entry.is_empty())
    }) {
        return Err(Error::Application(
            "设备未接受应用启动，请确认应用状态后重试",
        ));
    }
    Err(original)
}

async fn read_only(
    control: &Control,
    args: &[String],
    deadline: Instant,
) -> Result<Option<Output>> {
    control.check()?;
    let Some(remaining) = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
    else {
        return Ok(None);
    };
    match control.capture(args, Some(remaining)).await {
        Ok(output) => {
            let Ok(stderr) = std::str::from_utf8(&output.stderr) else {
                return Ok(None);
            };
            if stderr.lines().any(rules::adb_diagnostic_line) {
                return Ok(None);
            }
            Ok(Some(output))
        }
        Err(error @ (Error::CleanupFailed | Error::Cancelled)) => Err(error),
        Err(_) => {
            control.check()?;
            Ok(None)
        }
    }
}

fn installed(output: &str, package: &str) -> Option<bool> {
    let mut found = false;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let name = line.strip_prefix("package:")?;
        rules::package(name).ok()?;
        found |= name == package;
    }
    Some(found)
}
