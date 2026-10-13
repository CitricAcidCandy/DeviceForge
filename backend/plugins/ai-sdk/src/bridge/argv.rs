use crate::{config::Config, model::normalize_thread};
use deviceforge_plugin_runtime::InvocationContext;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;

pub fn expected(
    config: &Config,
    project: &Path,
    thread: Option<&str>,
    schema_path: Option<&Path>,
) -> Result<Vec<String>, String> {
    let mut argv = vec!["exec".into(), "--experimental-json".into()];
    let options = &config.thread_options;
    if let Some(model) = options.get("model").and_then(Value::as_str) {
        argv.extend(["--model".into(), model.into()]);
    }
    if thread.is_none()
        && let Some(source) = options.get("threadSource").and_then(Value::as_str)
    {
        argv.extend(["--thread-source".into(), source.into()]);
    }
    if let Some(sandbox) = options.get("sandboxMode").and_then(Value::as_str) {
        argv.extend(["--sandbox".into(), sandbox.into()]);
    }
    argv.extend([
        "--cd".into(),
        project.to_str().ok_or("SDK项目目录不是UTF-8")?.into(),
    ]);
    if options.get("skipGitRepoCheck").and_then(Value::as_bool) == Some(true) {
        argv.push("--skip-git-repo-check".into());
    }
    if let Some(schema) = schema_path {
        argv.extend([
            "--output-schema".into(),
            schema.to_str().ok_or("SDK临时schema路径不是UTF-8")?.into(),
        ]);
    }
    if let Some(effort) = options.get("modelReasoningEffort").and_then(Value::as_str) {
        argv.extend([
            "--config".into(),
            format!("model_reasoning_effort=\"{effort}\""),
        ]);
    }
    if let Some(enabled) = options.get("networkAccessEnabled").and_then(Value::as_bool) {
        argv.extend([
            "--config".into(),
            format!("sandbox_workspace_write.network_access={enabled}"),
        ]);
    }
    if let Some(mode) = options.get("webSearchMode").and_then(Value::as_str) {
        argv.extend(["--config".into(), format!("web_search=\"{mode}\"")]);
    } else if let Some(enabled) = options.get("webSearchEnabled").and_then(Value::as_bool) {
        argv.extend([
            "--config".into(),
            format!(
                "web_search=\"{}\"",
                if enabled { "live" } else { "disabled" }
            ),
        ]);
    }
    if let Some(policy) = options.get("approvalPolicy").and_then(Value::as_str) {
        argv.extend(["--config".into(), format!("approval_policy=\"{policy}\"")]);
    }
    if let Some(thread) = thread {
        argv.extend(["resume".into(), normalize_thread(thread)?]);
    }
    Ok(argv)
}

async fn schema(
    context: &InvocationContext,
    temporary: &Path,
    path: &Path,
    expected: &Value,
) -> Result<(), String> {
    context.check().map_err(|error| error.to_string())?;
    if !path.is_absolute() {
        return Err("SDK schema须为独立临时绝对路径".into());
    }
    let temporary = tokio::fs::canonicalize(temporary)
        .await
        .map_err(|_| "SDK临时目录资格检查失败")?;
    let resolved = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| "SDK schema路径资格检查失败")?;
    if !resolved.starts_with(&temporary) || resolved == temporary {
        return Err("SDK schema不属于本次临时目录".into());
    }
    let file = tokio::fs::File::open(resolved)
        .await
        .map_err(|_| "SDK临时schema无法读取")?;
    let metadata = file.metadata().await.map_err(|_| "SDK临时schema资格无效")?;
    if !metadata.is_file() || metadata.len() > 16_384 {
        return Err("SDK临时schema类型或大小超限".into());
    }
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "SDK临时schema读取失败")?;
    if bytes.len() > 16_384 {
        return Err("SDK临时schema超限".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "SDK临时schema不是JSON")?;
    if &value != expected {
        return Err("SDK实际schema与助手固定schema不匹配".into());
    }
    context.check().map_err(|error| error.to_string())
}

pub async fn verify(
    context: &InvocationContext,
    config: &Config,
    project: &Path,
    thread: Option<&str>,
    temporary: &Path,
    output_schema: Option<&Value>,
    argv: &[String],
) -> Result<(), String> {
    if argv.len() > 128
        || argv
            .iter()
            .any(|argument| argument.len() > 32_768 || argument.contains('\0'))
    {
        return Err("SDK实际exec参数超限".into());
    }
    let positions: Vec<_> = argv
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == "--output-schema").then_some(index))
        .collect();
    let path = match (output_schema, positions.as_slice()) {
        (None, []) => None,
        (Some(_), [index]) => Some(PathBuf::from(
            argv.get(index + 1).ok_or("SDK缺少实际schema路径")?,
        )),
        _ => return Err("SDK实际schema参数数量与调用不匹配".into()),
    };
    if argv != expected(config, project, thread, path.as_deref())? {
        return Err("SDK实际exec参数与固定档案、项目或线程不匹配".into());
    }
    if let (Some(path), Some(output_schema)) = (path, output_schema) {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(context.deadline())) => return Err("SDK schema核验期限已到期".into()),
            _ = context.cancellation().cancelled_owned() => return Err("SDK schema核验已取消".into()),
            outcome = schema(context, temporary, &path, output_schema) => outcome?,
        }
    }
    context.check().map_err(|error| error.to_string())
}
