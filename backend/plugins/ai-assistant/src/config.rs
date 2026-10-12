//! 项目和模型提供者归部署配置，不接受浏览器指定任意工作目录。
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub projects: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub state_root: PathBuf,
}
pub(crate) async fn read() -> Result<Config, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let path = match args.as_slice() {
        [] => std::env::current_exe()
            .map_err(|_| "无法定位AI助手")?
            .with_file_name("ai-assistant.config.json"),
        [flag, path] if flag == "--config" && PathBuf::from(path).is_absolute() => {
            PathBuf::from(path)
        }
        _ => return Err("AI助手只接受 --config 绝对路径".into()),
    };
    let raw = tokio::fs::read(&path)
        .await
        .map_err(|_| "未配置AI助手运行环境")?;
    if raw.len() > 65536 {
        return Err("AI助手部署配置超限".into());
    }
    let mut config: Config = serde_json::from_slice(&raw).map_err(|_| "AI助手部署配置无效")?;
    if config.state_root.as_os_str().is_empty() {
        config.state_root = path.with_file_name("ai-state");
    }
    if config.format_version != 1
        || config.executable.trim().is_empty()
        || config.projects.is_empty()
        || config.projects.len() > 64
        || config.projects.values().any(|path| !path.is_absolute())
    {
        return Err("AI助手部署版本或项目无效".into());
    }
    if config.environment.keys().any(|name| {
        name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    }) {
        return Err("AI助手环境变量名无效".into());
    }
    if !config.state_root.is_absolute() {
        return Err("AI会话存储目录须为绝对路径".into());
    }
    Ok(config)
}
