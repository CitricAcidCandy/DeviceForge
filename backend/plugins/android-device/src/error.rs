//! 公开失败只含固定中文，不携带ADB诊断、设备输入或部署路径。
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("操作已取消")]
    Cancelled,
    #[error("插件或工具执行期限已到期")]
    Timeout,
    #[error("数据超过插件限额")]
    TooLarge,
    #[error("输入无效：{0}")]
    Invalid(&'static str),
    #[error("工具依赖失败：{0}")]
    Dependency(&'static str),
    #[error("应用启动失败：{0}")]
    Application(&'static str),
    #[error("文件操作失败：{0}")]
    Io(&'static str),
    #[error("插件资源清理未确认")]
    CleanupFailed,
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

impl From<deviceforge_plugin_runtime::ContextError> for Error {
    fn from(error: deviceforge_plugin_runtime::ContextError) -> Self {
        match error {
            deviceforge_plugin_runtime::ContextError::Timeout => Self::Timeout,
            deviceforge_plugin_runtime::ContextError::Cancelled => Self::Cancelled,
        }
    }
}

impl From<deviceforge_tool_process::Error> for Error {
    fn from(error: deviceforge_tool_process::Error) -> Self {
        use deviceforge_tool_process::Error as Tool;
        match error {
            Tool::Cancelled => Self::Cancelled,
            Tool::Timeout => Self::Timeout,
            Tool::OutputTooLarge { .. } => Self::TooLarge,
            Tool::CleanupFailed { .. } => Self::CleanupFailed,
            Tool::Spawn(_) => {
                Self::Dependency("无法启动设备连接工具，请检查工具是否已安装且路径正确")
            }
            Tool::NonZeroExit { stderr, .. } => Self::Dependency(adb_failure(&stderr)),
            _ => Self::Dependency("设备连接工具执行失败，目前无法确认具体原因，请查看任务详情"),
        }
    }
}

fn adb_failure(stderr: &[u8]) -> &'static str {
    for line in String::from_utf8_lossy(stderr).lines() {
        let line = line.trim().to_ascii_lowercase();
        let line = line.strip_prefix("adb: ").unwrap_or(&line);
        let line = line
            .strip_prefix("error: ")
            .unwrap_or(line)
            .trim_end_matches('.');
        match line {
            "device offline" => return "设备已离线，请检查连接后重新获取设备列表",
            "device unauthorized" => return "设备尚未授权，请在设备上确认连接授权",
            "no devices/emulators found" | "no devices found" => {
                return "未找到已连接的设备，请连接设备后重新获取设备列表";
            }
            "more than one device/emulator" => {
                return "连接了多台设备，无法确定操作目标，请先选择要操作的设备";
            }
            line if line.starts_with("device ") && line.ends_with(" not found") => {
                return "目标设备已断开，请重新连接并获取设备列表";
            }
            _ => {}
        }
    }
    "设备连接工具执行失败，目前无法确认具体原因，请查看任务详情"
}

#[cfg(test)]
mod tests {
    use super::Error;
    use deviceforge_tool_process::Error as Tool;

    #[test]
    fn adb_failures_explain_known_device_states_without_leaking_raw_diagnostics() {
        for (stderr, reason) in [
            (
                "error: device offline",
                "设备已离线，请检查连接后重新获取设备列表",
            ),
            (
                "adb: device unauthorized.",
                "设备尚未授权，请在设备上确认连接授权",
            ),
            (
                "error: no devices/emulators found",
                "未找到已连接的设备，请连接设备后重新获取设备列表",
            ),
            (
                "adb: device 'private-serial' not found",
                "目标设备已断开，请重新连接并获取设备列表",
            ),
            (
                "error: more than one device/emulator",
                "连接了多台设备，无法确定操作目标，请先选择要操作的设备",
            ),
            (
                "private-unknown-diagnostic",
                "设备连接工具执行失败，目前无法确认具体原因，请查看任务详情",
            ),
        ] {
            let error: Error = Tool::NonZeroExit {
                code: Some(1),
                stderr: stderr.as_bytes().to_vec(),
            }
            .into();
            assert_eq!(error.to_string(), format!("工具依赖失败：{reason}"));
            assert!(!error.to_string().contains("private-"));
        }
    }

    #[test]
    fn missing_executable_is_not_reported_as_an_offline_device() {
        let error: Error = Tool::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)).into();
        assert_eq!(
            error.to_string(),
            "工具依赖失败：无法启动设备连接工具，请检查工具是否已安装且路径正确"
        );
    }
}
