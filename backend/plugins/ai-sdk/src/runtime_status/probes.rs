mod sdk;

pub use sdk::sdk;

use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, OutputStream, ScopeCompletion, ScopePolicy, StreamOptions,
    ToolCommand, spawn_scoped_stream,
};
use std::{ffi::OsString, path::Path, time::Duration};

pub struct Version {
    pub version: Option<String>,
    pub scope_complete: bool,
    pub cleanup_complete: bool,
    pub reason: Option<String>,
}

pub struct Loaded {
    pub loaded: bool,
    pub scope_complete: bool,
    pub reason: Option<String>,
}

fn failure(reason: &str, cleanup_complete: bool) -> Version {
    Version {
        version: None,
        scope_complete: false,
        cleanup_complete,
        reason: Some(reason.into()),
    }
}

pub(super) fn parse_version(bytes: &[u8], node: bool) -> Result<String, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "运行时版本探测不是UTF-8")?;
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    let version = text
        .strip_prefix(if node { "v" } else { "codex-cli " })
        .ok_or("运行时版本探测格式不符合固定入口")?;
    let parts: Vec<_> = version.split('.').collect();
    if version.len() > 64
        || parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || part.parse::<u32>().is_err()
        })
    {
        return Err("运行时版本探测字段无效".into());
    }
    Ok(version.into())
}

pub async fn version(executable: &Path, node: bool, context: &InvocationContext) -> Version {
    if context.check().is_err() {
        return failure("运行时版本探测已取消或到期", true);
    }
    let Some(executable) = executable.to_str() else {
        return failure("运行时版本入口不是UTF-8", true);
    };
    let arguments = ["--version".into()];
    let mut command = ToolCommand::new(executable, &arguments);
    command.environment = Environment::Restricted;
    for key in ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"] {
        command.env.insert(key.into(), OsString::new());
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env.insert("SystemRoot".into(), root);
    }
    let deadline = tokio::time::Instant::from_std(context.deadline())
        .min(tokio::time::Instant::now() + Duration::from_secs(5));
    let mut execution = ExecutionOptions::new(deadline);
    execution.stdout_limit = 1024;
    execution.stderr_limit = 8192;
    execution.cleanup_timeout = Duration::from_millis(1000);
    let mut options = StreamOptions::new(execution);
    options.channel_capacity = 4;
    options.input_limit = 0;
    let mut process = match spawn_scoped_stream(
        command,
        options,
        context.cancellation(),
        ScopePolicy::OwnedTree,
    )
    .await
    {
        Ok(process) => process,
        Err(_) => return failure("当前平台运行时版本完整范围启动失败", true),
    };
    let input_closed = process.input().close().await.is_ok();
    if !input_closed {
        process.cancel();
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    while let Some(chunk) = process.recv().await {
        match chunk.stream {
            OutputStream::Stdout => stdout.extend_from_slice(&chunk.bytes),
            OutputStream::Stderr if stderr.len() < 8192 => {
                let remaining = 8192 - stderr.len();
                stderr.extend_from_slice(&chunk.bytes[..chunk.bytes.len().min(remaining)]);
            }
            OutputStream::Stderr => {}
        }
    }
    let exit = match process.wait().await {
        Ok(exit) => exit,
        Err(_) => return failure("运行时版本完整范围实际退出未确认", false),
    };
    if exit.scope != ScopeCompletion::Complete {
        return failure("运行时版本完整范围清理失败", false);
    }
    let successful = input_closed
        && context.check().is_ok()
        && exit.direct.is_ok_and(|direct| direct.status.success());
    if !successful {
        let diagnostic = String::from_utf8_lossy(&stderr).trim().to_string();
        let reason = if diagnostic.is_empty() {
            "运行时版本探测未成功结束".to_string()
        } else {
            format!("运行时版本探测未成功结束：{diagnostic}")
        };
        return failure(&reason, true);
    }
    match parse_version(&stdout, node) {
        Ok(version) => Version {
            version: Some(version),
            scope_complete: true,
            cleanup_complete: true,
            reason: None,
        },
        Err(reason) => failure(&reason, true),
    }
}
