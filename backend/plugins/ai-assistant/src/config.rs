//! 项目和模型提供者归部署配置，不接受浏览器指定任意工作目录。
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
};
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
fn paths(
    managed: Option<PathBuf>,
    args: &[OsString],
    executable: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let default = executable.with_file_name("ai-assistant.config.json");
    if let Some(path) = managed {
        if !path.is_absolute() {
            return Err("AI助手配置须为绝对路径".into());
        }
        let legacy = match args {
            [flag, file] if flag == "--config" && PathBuf::from(file).is_absolute() => {
                PathBuf::from(file)
            }
            _ => default,
        };
        return Ok((path, legacy));
    }
    let path = match args {
        [] => default,
        [flag, path] if flag == "--config" && PathBuf::from(path).is_absolute() => {
            PathBuf::from(path)
        }
        _ => return Err("AI助手只接受 --config 绝对路径".into()),
    };
    Ok((path.clone(), path))
}
pub(crate) async fn read() -> Result<Config, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let executable = std::env::current_exe().map_err(|_| "无法定位AI助手")?;
    let (path, legacy_path) = paths(
        apk_plugin_sdk::configuration::managed_config_path(),
        &args,
        &executable,
    )?;
    read_path(&path, &legacy_path).await
}
async fn read_path(path: &Path, legacy_path: &Path) -> Result<Config, String> {
    let raw = tokio::fs::read(&path)
        .await
        .map_err(|_| "未配置AI助手运行环境")?;
    if raw.len() > 65536 {
        return Err("AI助手部署配置超限".into());
    }
    let mut config: Config = serde_json::from_slice(&raw).map_err(|_| "AI助手部署配置无效")?;
    if config.state_root.as_os_str().is_empty() {
        // 宿主修订移动配置文件时，省略状态目录仍沿用旧部署位置。
        config.state_root = legacy_path.with_file_name("ai-state");
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn revision_is_consumed_without_relocating_legacy_state() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("ai-assistant.config.json");
        let managed = root.path().join("revisions").join("1.json");
        tokio::fs::create_dir(managed.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&legacy, b"invalid").await.unwrap();
        tokio::fs::write(&managed, serde_json::to_vec(&json!({
            "format_version":1, "executable":"codex", "projects":{"managed":root.path()}, "environment":{}
        })).unwrap()).await.unwrap();
        let (path, state_base) =
            paths(Some(managed.clone()), &[], &root.path().join("plugin.exe")).unwrap();
        let config = read_path(&path, &state_base).await.unwrap();
        assert!(config.projects.contains_key("managed"));
        assert_eq!(config.state_root, root.path().join("ai-state"));
        tokio::fs::remove_file(managed).await.unwrap();
        assert!(read_path(&path, &state_base).await.is_err());
    }
}
