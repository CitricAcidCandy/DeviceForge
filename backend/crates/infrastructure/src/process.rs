use crate::artifact_files::Temporary;
use apk_domain::{Error, Result};
use deviceforge_tool_process::{
    self as tool_process, Environment, ExecutionOptions, OutputStream, ToolCommand,
};
use std::sync::Arc;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
const OUTPUT_LIMIT: u64 = 1024 * 1024;
pub(crate) mod cooperative;

async fn bounded(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| Error::Dependency(e.to_string()))?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(Error::Dependency("工具输出超过 1 MiB".into()));
    }
    Ok(bytes)
}
fn command(executable: &str, args: &[String], plugin: bool) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if plugin {
        command
            .env_clear()
            .envs(tool_process::restricted_environment());
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

/// 保留宿主原错误类别与两种输出模式的非零退出文案。
fn map_error(error: tool_process::Error, file_output: bool) -> Error {
    match error {
        tool_process::Error::Cancelled => Error::Cancelled,
        tool_process::Error::Timeout => Error::Timeout,
        tool_process::Error::InvalidOptions(message) => Error::Invalid(message.into()),
        tool_process::Error::Spawn(error) | tool_process::Error::ProcessIo(error) => {
            Error::Dependency(error.to_string())
        }
        tool_process::Error::FileIo(error) => Error::Storage(error.to_string()),
        tool_process::Error::OutputTooLarge {
            stream: OutputStream::Stdout,
            ..
        } if file_output => Error::TooLarge,
        tool_process::Error::OutputTooLarge { .. } => {
            Error::Dependency("工具输出超过 1 MiB".into())
        }
        tool_process::Error::NonZeroExit { code, stderr } => {
            let stderr = String::from_utf8_lossy(&stderr);
            if file_output {
                Error::Dependency(format!("工具退出码 {:?}：{}", code, stderr.trim()))
            } else {
                Error::Dependency(stderr.trim().to_owned())
            }
        }
        tool_process::Error::CleanupFailed { .. } => Error::CleanupFailed,
    }
}

async fn capture(
    executable: &str,
    args: &[String],
    input: Option<Vec<u8>>,
    deadline: Instant,
    cancel: CancellationToken,
    plugin: bool,
    directory: Option<&std::path::Path>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    crate::execution_deadline::check(&cancel, Some(deadline))?;
    let mut command = ToolCommand::new(executable, args);
    command.input = input.as_deref();
    command.directory = directory;
    if plugin {
        command.environment = Environment::Restricted;
        if let Some(directory) = directory {
            for key in ["TEMP", "TMP", "TMPDIR"] {
                command
                    .env
                    .insert(key.into(), directory.as_os_str().to_owned());
            }
        }
    }
    let options = ExecutionOptions::new(deadline);
    await_capture(
        tool_process::capture(command, options, cancel.clone()),
        &cancel,
        deadline,
    )
    .await
}

async fn await_capture(
    work: impl std::future::Future<Output = tool_process::Result<tool_process::Output>>,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<(Vec<u8>, Vec<u8>)> {
    tokio::pin!(work);
    let mut cancelled = None;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // 在观察取消的时刻固定原因；后续有界清理耗时不能改写提前取消。
            cancelled = Some(crate::execution_deadline::classify(Error::Cancelled, Some(deadline)));
            work.await
        },
        result = &mut work => result,
    };
    result
        .map(|output| (output.stdout, output.stderr))
        .map_err(|error| match error {
            tool_process::Error::Cancelled => cancelled.unwrap_or_else(|| {
                crate::execution_deadline::classify(Error::Cancelled, Some(deadline))
            }),
            other => map_error(other, false),
        })
}

pub(crate) struct PluginInvocation<'a> {
    pub executable: &'a str,
    pub args: &'a [String],
    pub input: Vec<u8>,
    pub deadline: Instant,
    pub cancel: CancellationToken,
    pub directory: Option<&'a std::path::Path>,
    pub configuration: Option<&'a std::path::Path>,
    pub resources: Option<&'a std::path::Path>,
}

/// 配置路径在本次调用开始时固定，后续保存不会改变活动进程的配置快照。
pub(crate) async fn configured_plugin(call: PluginInvocation<'_>) -> Result<Vec<u8>> {
    crate::execution_deadline::check(&call.cancel, Some(call.deadline))?;
    let lease =
        crate::plugin_resources::acquire(call.resources, &call.cancel, call.deadline).await?;
    let mut command = ToolCommand::new(call.executable, call.args);
    command.input = Some(&call.input);
    command.directory = call.directory;
    command.environment = Environment::Restricted;
    if let Some(path) = call.configuration {
        command.env.insert(
            "DEVICEFORGE_PLUGIN_CONFIG".into(),
            path.as_os_str().to_owned(),
        );
    }
    if let Some(path) = call.resources {
        command.env.insert(
            "DEVICEFORGE_PLUGIN_RESOURCES".into(),
            path.as_os_str().to_owned(),
        );
    }
    if let Some(directory) = call.directory {
        for key in ["TEMP", "TMP", "TMPDIR"] {
            command
                .env
                .insert(key.into(), directory.as_os_str().to_owned());
        }
    }
    await_capture(
        tool_process::capture_with_lease(
            command,
            ExecutionOptions::new(call.deadline),
            call.cancel.clone(),
            lease,
        ),
        &call.cancel,
        call.deadline,
    )
    .await
    .map(|(output, _)| output)
}

/// 包副本租约交给公共直接进程所有者，外层等待丢弃不提前删除目录。
pub(crate) async fn package_output_until(
    executable: &str,
    args: &[String],
    deadline: Instant,
    cancel: CancellationToken,
    directory: Arc<Temporary>,
    restricted: bool,
) -> Result<(Vec<u8>, Vec<u8>)> {
    crate::execution_deadline::check(&cancel, Some(deadline))?;
    let mut command = ToolCommand::new(executable, args);
    if restricted {
        command.directory = Some(directory.path());
        command.environment = Environment::Restricted;
        for key in ["TEMP", "TMP", "TMPDIR"] {
            command
                .env
                .insert(key.into(), directory.path().as_os_str().to_owned());
        }
    }
    let work = tool_process::capture_with_lease(
        command,
        ExecutionOptions::new(deadline),
        cancel.clone(),
        directory.clone(),
    );
    await_capture(work, &cancel, deadline).await
}
pub async fn run(
    executable: &str,
    args: &[String],
    input: Option<Vec<u8>>,
    timeout: Duration,
    cancel: CancellationToken,
    plugin: bool,
) -> Result<Vec<u8>> {
    run_until(
        executable,
        args,
        input,
        Instant::now() + timeout,
        cancel,
        plugin,
    )
    .await
}

/// 使用调用方的绝对截止点，不为进程执行重新获得预算。
pub(crate) async fn run_until(
    executable: &str,
    args: &[String],
    input: Option<Vec<u8>>,
    deadline: Instant,
    cancel: CancellationToken,
    plugin: bool,
) -> Result<Vec<u8>> {
    capture(executable, args, input, deadline, cancel, plugin, None)
        .await
        .map(|(output, _)| output)
}

pub async fn run_text(
    executable: &str,
    args: &[String],
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<String> {
    let (output, errors) = capture(
        executable,
        args,
        None,
        Instant::now() + timeout,
        cancel,
        false,
        None,
    )
    .await?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output),
        String::from_utf8_lossy(&errors)
    )
    .trim()
    .to_owned())
}

/// 将二进制标准输出流式写入受控文件，取消或超时时等待工具退出。
pub async fn run_to_file(
    executable: &str,
    args: &[String],
    file: &mut tokio::fs::File,
    limit: u64,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<()> {
    run_to_file_until(
        executable,
        args,
        file,
        limit,
        Instant::now() + timeout,
        cancel,
    )
    .await
}

/// 文件输出使用原绝对截止点，保留独立文件与诊断限额。
pub async fn run_to_file_until(
    executable: &str,
    args: &[String],
    file: &mut tokio::fs::File,
    limit: u64,
    deadline: Instant,
    cancel: CancellationToken,
) -> Result<()> {
    crate::execution_deadline::check(&cancel, Some(deadline))?;
    let command = ToolCommand::new(executable, args);
    let options = ExecutionOptions::new(deadline);
    tool_process::capture_to_file(command, options, cancel, file, limit)
        .await
        .map_err(|error| map_error(error, true))
}
/// 在独占工作目录中运行受控工具，并剥离宿主凭据环境。
pub async fn run_isolated(
    executable: &str,
    args: &[String],
    timeout: Duration,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<Vec<u8>> {
    run_isolated_until(
        executable,
        args,
        Instant::now() + timeout,
        cancel,
        directory,
    )
    .await
}

/// 独占目录与受限环境不变，工具共用调用方的原截止点。
pub(crate) async fn run_isolated_until(
    executable: &str,
    args: &[String],
    deadline: Instant,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<Vec<u8>> {
    capture(
        executable,
        args,
        None,
        deadline,
        cancel,
        true,
        Some(directory),
    )
    .await
    .map(|(output, _)| output)
}

/// 返回受控工具的合并诊断，调用方负责固定错误与失败文本判定。
pub(crate) async fn isolated_text(
    executable: &str,
    args: &[String],
    timeout: Duration,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<String> {
    isolated_text_until(
        executable,
        args,
        Instant::now() + timeout,
        cancel,
        directory,
    )
    .await
}

/// 合并诊断共用原截止点，不把准备耗时排除在预算外。
pub(crate) async fn isolated_text_until(
    executable: &str,
    args: &[String],
    deadline: Instant,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<String> {
    let (stdout, stderr) = capture(
        executable,
        args,
        None,
        deadline,
        cancel,
        true,
        Some(directory),
    )
    .await?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_command_uses_shared_restricted_runtime_environment() {
        fn normalized(key: &std::ffi::OsStr) -> std::ffi::OsString {
            if cfg!(windows) {
                key.to_string_lossy().to_uppercase().into()
            } else {
                key.to_owned()
            }
        }
        let command = command("unused-plugin-environment-test", &[], true);
        let actual: std::collections::BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (normalized(key), value.to_owned())))
            .collect();
        let expected: std::collections::BTreeMap<_, _> = tool_process::restricted_environment()
            .into_iter()
            .map(|(key, value)| (normalized(&key), value))
            .collect();
        assert!(
            actual == expected,
            "宿主启动插件须保留公共运行环境快照，且不能额外继承宿主变量"
        );
    }

    #[test]
    fn cleanup_failure_is_not_replaced_by_its_cause() {
        for file_output in [false, true] {
            let error = tool_process::Error::CleanupFailed {
                cause: Box::new(tool_process::Error::Timeout),
            };
            assert!(matches!(
                map_error(error, file_output),
                Error::CleanupFailed
            ));
        }
    }

    #[test]
    fn file_output_limit_preserves_stdout_and_stderr_error_categories() {
        assert!(matches!(
            map_error(
                tool_process::Error::OutputTooLarge {
                    stream: OutputStream::Stdout,
                    limit: 64,
                },
                true,
            ),
            Error::TooLarge
        ));
        assert!(matches!(
            map_error(
                tool_process::Error::OutputTooLarge {
                    stream: OutputStream::Stderr,
                    limit: OUTPUT_LIMIT,
                },
                true,
            ),
            Error::Dependency(message) if message == "工具输出超过 1 MiB"
        ));
    }

    #[test]
    fn nonzero_exit_preserves_trimmed_capture_and_file_diagnostics() {
        for (file_output, expected) in
            [(false, "工具失败"), (true, "工具退出码 Some(17)：工具失败")]
        {
            let error = tool_process::Error::NonZeroExit {
                code: Some(17),
                stderr: " \t工具失败\r\n ".as_bytes().to_vec(),
            };
            assert!(matches!(
                map_error(error, file_output),
                Error::Dependency(message) if message == expected
            ));
        }
    }

    #[tokio::test]
    async fn cancelled_before_spawn_does_not_resolve_or_start_program() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            run(
                "missing-program-must-not-start",
                &[],
                None,
                Duration::from_secs(1),
                token,
                false
            )
            .await,
            Err(Error::Cancelled)
        ));
    }

    #[tokio::test]
    async fn expired_outer_cancellation_does_not_spawn_and_is_reported_as_timeout() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            run_until(
                "missing-program-must-not-start",
                &[],
                Some(b"must-not-send".to_vec()),
                Instant::now() - Duration::from_secs(1),
                cancel,
                true,
            )
            .await,
            Err(Error::Timeout)
        ));
    }
    #[tokio::test]
    async fn cancellation_and_timeout_are_bounded() {
        let token = CancellationToken::new();
        token.cancel();
        let (exe, args) = if cfg!(windows) {
            ("ping", vec!["-n".into(), "10".into(), "127.0.0.1".into()])
        } else {
            ("sleep", vec!["10".into()])
        };
        assert!(matches!(
            run(exe, &args, None, Duration::from_secs(30), token, false).await,
            Err(Error::Cancelled)
        ));
        assert!(matches!(
            run(
                exe,
                &args,
                None,
                Duration::from_millis(30),
                CancellationToken::new(),
                false
            )
            .await,
            Err(Error::Timeout)
        ));
    }
}
