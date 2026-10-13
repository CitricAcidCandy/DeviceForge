//! ADB Keyboard 的固定资格核验与 Unicode 广播；不切换或恢复设备输入法。
use crate::{Control, Error, Result, config::Config, rules::Action, rules::unicode};
use serde_json::{Value, json};

pub(crate) async fn dispatch(
    control: &Control,
    config: &Config,
    device_id: &str,
    action: &Action,
) -> Result<Value> {
    let text = match action {
        Action::Text { text, .. } => text,
        _ => return Err(Error::Invalid("Unicode输入只适用于text动作")),
    };
    let unicode_config = config
        .unicode_input
        .as_ref()
        .ok_or(Error::Dependency("未配置ADB Keyboard Unicode输入"))?;
    let installed = control
        .capture(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "-T".into(),
                "pm".into(),
                "path".into(),
                unicode_config.package.clone(),
            ],
            None,
        )
        .await?;
    if !accepted_output(&installed, |stdout| {
        stdout.lines().any(|line| {
            line.trim()
                .strip_prefix("package:")
                .is_some_and(|path| !path.trim().is_empty())
        })
    })? {
        return Err(Error::Dependency("ADB Keyboard未安装"));
    }
    let enabled = control
        .capture(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "-T".into(),
                "ime".into(),
                "list".into(),
                "-s".into(),
            ],
            None,
        )
        .await?;
    if !accepted_output(&enabled, |stdout| {
        stdout
            .lines()
            .any(|line| line.trim() == unicode_config.component)
    })? {
        return Err(Error::Dependency("ADB Keyboard未启用"));
    }
    let current = control
        .capture(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "-T".into(),
                "settings".into(),
                "get".into(),
                "secure".into(),
                "default_input_method".into(),
            ],
            None,
        )
        .await?;
    if !accepted_output(&current, |stdout| stdout.trim() == unicode_config.component)? {
        return Err(Error::Dependency("ADB Keyboard不是当前输入法"));
    }
    control.check()?;
    let encoded = unicode::encode_base64(text);
    let broadcast = control
        .capture(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "-T".into(),
                "am".into(),
                "broadcast".into(),
                "-a".into(),
                unicode_config.action.clone(),
                "--es".into(),
                unicode_config.extra.clone(),
                encoded,
            ],
            None,
        )
        .await?;
    if !accepted_output(&broadcast, |stdout| {
        stdout
            .lines()
            .any(|line| line.trim_start().starts_with("Broadcast completed:"))
    })? {
        return Err(Error::Dependency("ADB Keyboard广播未被接受"));
    }
    if let Action::Text { enter: true, .. } = action {
        let enter = control
            .capture(
                &[
                    "-s".into(),
                    device_id.into(),
                    "shell".into(),
                    "-T".into(),
                    "input".into(),
                    "keyevent".into(),
                    "66".into(),
                ],
                None,
            )
            .await?;
        if !accepted_output(&enter, |stdout| stdout.trim().is_empty())? {
            return Err(Error::Dependency("回车按键未被ADB接受"));
        }
    }
    Ok(json!({
        "device_id": device_id,
        "action": "text",
        "transport": "adb_keyboard_base64",
        "bytes": text.len(),
        "dispatched": true,
    }))
}

fn accepted_output(
    output: &deviceforge_tool_process::Output,
    predicate: impl FnOnce(&str) -> bool,
) -> Result<bool> {
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| Error::Dependency("ADB输出不是有效UTF-8文本"))?;
    let stderr = std::str::from_utf8(&output.stderr)
        .map_err(|_| Error::Dependency("ADB输出不是有效UTF-8文本"))?;
    if !stderr.trim().is_empty() {
        return Ok(false);
    }
    Ok(predicate(stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_acceptance_does_not_expose_diagnostics() {
        let output = deviceforge_tool_process::Output {
            stdout: b"Broadcast completed: result=0\n".to_vec(),
            stderr: Vec::new(),
        };
        assert!(accepted_output(&output, |value| value.contains("Broadcast completed")).unwrap());
        let failed = deviceforge_tool_process::Output {
            stdout: b"Broadcast completed: result=0\n".to_vec(),
            stderr: b"denied\n".to_vec(),
        };
        assert!(!accepted_output(&failed, |_| true).unwrap());
    }

    #[test]
    fn package_probe_uses_standard_pm_path_output_shape() {
        let installed = deviceforge_tool_process::Output {
            stdout: b"package:/data/app/com.android.adbkeyboard/base.apk\n".to_vec(),
            stderr: Vec::new(),
        };
        assert!(
            accepted_output(&installed, |value| {
                value.lines().any(|line| {
                    line.trim()
                        .strip_prefix("package:")
                        .is_some_and(|path| !path.trim().is_empty())
                })
            })
            .unwrap()
        );
        let empty = deviceforge_tool_process::Output {
            stdout: b"package:\n".to_vec(),
            stderr: Vec::new(),
        };
        assert!(
            !accepted_output(&empty, |value| {
                value.lines().any(|line| {
                    line.trim()
                        .strip_prefix("package:")
                        .is_some_and(|path| !path.trim().is_empty())
                })
            })
            .unwrap()
        );
    }
}
