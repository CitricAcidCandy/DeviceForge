use apk_domain::{Error, Result};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
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
        command.env_clear();
        for key in ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
async fn capture(
    executable: &str,
    args: &[String],
    input: Option<Vec<u8>>,
    timeout: Duration,
    cancel: CancellationToken,
    plugin: bool,
    directory: Option<&std::path::Path>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut command = command(executable, args, plugin);
    if let Some(directory) = directory {
        command.current_dir(directory);
        if plugin {
            for key in ["TEMP", "TMP", "TMPDIR"] {
                command.env(key, directory);
            }
        }
    }
    let mut child = command
        .spawn()
        .map_err(|e| Error::Dependency(e.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::Dependency("缺少标准输入".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Dependency("缺少标准输出".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Dependency("缺少标准错误".into()))?;
    let work = async {
        let write = async {
            if let Some(input) = input {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|e| Error::Dependency(e.to_string()))?;
            }
            drop(stdin);
            Ok::<_, Error>(())
        };
        let ((), output, errors, status) =
            tokio::try_join!(write, bounded(stdout), bounded(stderr), async {
                child
                    .wait()
                    .await
                    .map_err(|e| Error::Dependency(e.to_string()))
            })?;
        if !status.success() {
            return Err(Error::Dependency(
                String::from_utf8_lossy(&errors).trim().to_owned(),
            ));
        }
        Ok((output, errors))
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        value = tokio::time::timeout(timeout, work) => value.unwrap_or(Err(Error::Timeout)),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
pub async fn run(
    executable: &str,
    args: &[String],
    input: Option<Vec<u8>>,
    timeout: Duration,
    cancel: CancellationToken,
    plugin: bool,
) -> Result<Vec<u8>> {
    capture(executable, args, input, timeout, cancel, plugin, None)
        .await
        .map(|(output, _)| output)
}

pub(crate) async fn run_plugin(
    executable: &str,
    args: &[String],
    input: Vec<u8>,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<Vec<u8>> {
    capture(
        executable,
        args,
        Some(input),
        Duration::from_secs(60),
        cancel,
        true,
        Some(directory),
    )
    .await
    .map(|(output, _)| output)
}
pub async fn run_text(
    executable: &str,
    args: &[String],
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<String> {
    let (output, errors) = capture(executable, args, None, timeout, cancel, false, None).await?;
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
    let mut child = command(executable, args, false)
        .spawn()
        .map_err(|e| Error::Dependency(e.to_string()))?;
    drop(child.stdin.take());
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Dependency("缺少标准输出".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Dependency("缺少标准错误".into()))?;
    let work = async {
        let copy = async {
            let mut buffer = [0; 64 * 1024];
            let mut total = 0u64;
            loop {
                let count = stdout
                    .read(&mut buffer)
                    .await
                    .map_err(|e| Error::Dependency(e.to_string()))?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                if total > limit {
                    return Err(Error::TooLarge);
                }
                file.write_all(&buffer[..count])
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))?;
            }
            file.flush()
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            Ok::<_, Error>(())
        };
        let ((), errors, status) = tokio::try_join!(copy, bounded(stderr), async {
            child
                .wait()
                .await
                .map_err(|e| Error::Dependency(e.to_string()))
        })?;
        if !status.success() {
            return Err(Error::Dependency(format!(
                "工具退出码 {:?}：{}",
                status.code(),
                String::from_utf8_lossy(&errors).trim()
            )));
        }
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        value = tokio::time::timeout(timeout, work) => value.unwrap_or(Err(Error::Timeout)),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
/// 在独占工作目录中运行受控工具，并剥离宿主凭据环境。
pub(crate) async fn run_isolated(
    executable: &str,
    args: &[String],
    timeout: Duration,
    cancel: CancellationToken,
    directory: &std::path::Path,
) -> Result<Vec<u8>> {
    capture(
        executable,
        args,
        None,
        timeout,
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
    let (stdout, stderr) = capture(
        executable,
        args,
        None,
        timeout,
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
