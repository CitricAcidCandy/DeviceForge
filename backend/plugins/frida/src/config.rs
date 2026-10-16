//! 配置仅由部署者提供；配置路径不会进入浏览器输入。
use crate::{Error, Result, files, input};
use serde::Deserialize;
use std::path::{Path, PathBuf};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Tools {
    pub adb: String,
    pub frida: String,
    pub frida_ps: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    pub tools: Tools,
    #[serde(default = "remote_default")]
    pub server_path: String,
    #[serde(default)]
    pub scratch_root: Option<PathBuf>,
}
fn remote_default() -> String {
    "/data/local/tmp/deviceforge-frida-server".into()
}
pub(crate) fn remote_path(value: &str) -> Result<()> {
    input::text(value, 512)?;
    if !value.starts_with("/data/local/tmp/")
        || value.split('/').any(|p| p == ".." || p == ".")
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        || value.ends_with('/')
    {
        return Err(Error::Invalid(
            "远端部署路径须为/data/local/tmp下的固定普通路径",
        ));
    }
    Ok(())
}
fn program(value: &str) -> Result<()> {
    input::text(value, 4096)?;
    let path = Path::new(value);
    if path.is_absolute() {
        files::regular(path, false)?;
    } else if value.starts_with('-')
        || value.contains(['/', '\\', ':'])
        || value.chars().any(char::is_whitespace)
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
        || path.components().count() != 1
    {
        return Err(Error::Invalid("工具入口须为绝对文件路径或单一程序名"));
    }
    Ok(())
}
impl Config {
    pub(crate) fn read(check: impl Fn() -> Result<()>) -> Result<Self> {
        let path = if let Some(path) = apk_plugin_sdk::configuration::managed_config_path() {
            path
        } else {
            let mut args = std::env::args_os().skip(1);
            let path = match args.next() {
                None => std::env::current_exe()
                    .map_err(|_| Error::Io("插件入口不可定位"))?
                    .parent()
                    .ok_or(Error::Invalid("插件没有部署目录"))?
                    .join("frida.config.json"),
                Some(flag) if flag == "--config" => {
                    PathBuf::from(args.next().ok_or(Error::Invalid("缺少配置路径"))?)
                }
                _ => return Err(Error::Invalid("只支持--config部署参数")),
            };
            if args.next().is_some() {
                return Err(Error::Invalid("部署参数过多"));
            }
            path
        };
        let data = files::read(&path, 65536, &check)?;
        let config: Self =
            serde_json::from_slice(&data).map_err(|_| Error::Invalid("配置JSON无效"))?;
        if config.format_version != 1 {
            return Err(Error::Invalid("配置版本须为1"));
        }
        program(&config.tools.adb)?;
        program(&config.tools.frida)?;
        program(&config.tools.frida_ps)?;
        remote_path(&config.server_path)?;
        if let Some(root) = &config.scratch_root {
            files::regular(root, true)?;
        }
        check()?;
        Ok(config)
    }
}
