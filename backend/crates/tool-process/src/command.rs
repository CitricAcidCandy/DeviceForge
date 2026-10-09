use crate::{Environment, ToolCommand};
use std::process::Stdio;
use tokio::process::Command;

pub(crate) fn prepare(spec: &ToolCommand<'_>) -> Command {
    let mut command = Command::new(spec.executable);
    command
        .args(spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if spec.environment == Environment::Restricted {
        command.env_clear();
        for key in ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    if let Some(directory) = spec.directory {
        command.current_dir(directory);
    }
    command.envs(&spec.env);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
