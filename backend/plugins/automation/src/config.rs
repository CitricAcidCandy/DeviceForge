//! 部署者配置本机能力与工具入口，浏览器不得提交程序路径。
use crate::{Error, Result, files, input};
use serde::Deserialize;
use std::path::{Path, PathBuf};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    #[serde(default)]
    pub adb: Option<String>,
    #[serde(default)]
    pub input_trace: Option<String>,
    #[serde(default)]
    pub desktop_enabled: bool,
    #[serde(default)]
    pub scratch_root: Option<PathBuf>,
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
        let mut args = std::env::args_os().skip(1);
        let path = match args.next() {
            None => std::env::current_exe()
                .map_err(|_| Error::Io("插件入口不可定位"))?
                .with_file_name("automation.config.json"),
            Some(flag) if flag == "--config" => {
                PathBuf::from(args.next().ok_or(Error::Invalid("缺少配置路径"))?)
            }
            _ => return Err(Error::Invalid("只支持--config部署参数")),
        };
        if args.next().is_some() {
            return Err(Error::Invalid("部署参数过多"));
        }
        let bytes = files::read(&path, 16384, &check)?;
        let config: Self =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("配置JSON无效"))?;
        if config.format_version != 1 {
            return Err(Error::Invalid("配置版本须为1"));
        }
        for executable in [&config.adb, &config.input_trace].into_iter().flatten() {
            program(executable)?;
        }
        if let Some(root) = &config.scratch_root {
            files::regular(root, true)?;
        }
        check()?;
        Ok(config)
    }
    pub(crate) fn desktop(&self) -> Result<()> {
        if !cfg!(windows) {
            return Err(Error::Dependency("本机桌面操作仅支持Windows"));
        }
        if !self.desktop_enabled {
            return Err(Error::Dependency("部署配置尚未启用本机桌面能力"));
        }
        Ok(())
    }
    pub(crate) fn trace(&self) -> Result<&str> {
        self.desktop()?;
        self.input_trace
            .as_deref()
            .ok_or(Error::Dependency("尚未配置InputTrace工具"))
    }
}
