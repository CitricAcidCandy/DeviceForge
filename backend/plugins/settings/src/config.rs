//! 仅部署者选择存储根目录，业务请求不得提供服务器路径。
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    format_version: u32,
    pub storage_root: PathBuf,
    #[serde(default)]
    pub remote: Option<Remote>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Remote {
    pub base_url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

pub(crate) async fn read() -> Result<Config, String> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let path = match arguments.as_slice() {
        [] => std::env::current_exe()
            .map_err(|_| "无法定位配置插件".to_owned())?
            .with_file_name("settings.config.json"),
        [flag, path] if flag == "--config" && PathBuf::from(path).is_absolute() => {
            PathBuf::from(path)
        }
        _ => return Err("配置插件只接受 --config 绝对路径".into()),
    };
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "部署者未配置 settings.config.json".to_owned())?;
    if metadata.len() > 16_384 || !metadata.is_file() {
        return Err("配置插件部署配置无效".into());
    }
    let raw = tokio::fs::read(path)
        .await
        .map_err(|_| "无法读取配置插件部署配置".to_owned())?;
    let config: Config =
        serde_json::from_slice(&raw).map_err(|_| "配置插件部署配置格式无效".to_owned())?;
    if config.format_version != 1 || !config.storage_root.is_absolute() {
        return Err("配置插件部署版本或根目录无效".into());
    }
    if let Some(remote) = &config.remote {
        let url = reqwest::Url::parse(&remote.base_url).map_err(|_| "远端配置地址无效")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !remote.base_url.ends_with('/')
        {
            return Err("远端配置地址须为无凭据和查询的HTTP目录地址".into());
        }
        if remote.headers.len() > 32 {
            return Err("远端配置头数量超限".into());
        }
    }
    Ok(config)
}
