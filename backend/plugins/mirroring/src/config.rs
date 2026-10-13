//! scrcpy 和 ADB 固定由部署者配置，不继承服务凭据环境。
use serde::Deserialize;
use std::path::PathBuf;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    pub scrcpy: String,
    pub adb: String,
    pub live: Option<Live>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Live {
    pub scrcpy_server: PathBuf,
    pub server_version: String,
}
pub(crate) async fn read() -> Result<Config, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let path = match args.as_slice() {
        [] => std::env::current_exe()
            .map_err(|_| "无法定位投屏插件")?
            .with_file_name("mirroring.config.json"),
        [flag, path] if flag == "--config" && PathBuf::from(path).is_absolute() => {
            PathBuf::from(path)
        }
        _ => return Err("投屏插件只接受 --config 绝对路径".into()),
    };
    use tokio::io::AsyncReadExt;
    let mut raw = Vec::new();
    tokio::fs::File::open(path)
        .await
        .map_err(|_| "未配置投屏工具")?
        .take(16385)
        .read_to_end(&mut raw)
        .await
        .map_err(|_| "无法读取投屏部署配置")?;
    if raw.len() > 16384 {
        return Err("投屏部署配置超限".into());
    }
    let config: Config = serde_json::from_slice(&raw).map_err(|_| "投屏部署配置无效")?;
    if config.format_version != 1 || config.scrcpy.is_empty() || config.adb.is_empty() {
        return Err("投屏部署版本或工具入口无效".into());
    }
    if let Some(live) = &config.live
        && (!live.scrcpy_server.is_absolute() || live.server_version != "3.3.1")
    {
        return Err("直播服务文件须为绝对路径且版本须为3.3.1".into());
    }
    Ok(config)
}
