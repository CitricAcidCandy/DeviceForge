//! 部署配置模型与工具资格；业务请求不能选择工具入口。
mod paths;
mod reading;

use crate::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use serde::Deserialize;
use std::path::{Component, Path};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Tools {
    pub adb: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    #[serde(default)]
    pub tools: Tools,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            format_version: 1,
            tools: Tools::default(),
        }
    }
}

fn text(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(Error::Invalid("配置字符串为空、超限或含控制符"));
    }
    Ok(())
}

fn absolute(path: &Path) -> Result<()> {
    text(path.to_str().ok_or(Error::Invalid("配置路径须为UTF-8"))?)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::Invalid("配置路径须为不含父路径的绝对路径"));
    }
    Ok(())
}

fn program(value: &str) -> Result<()> {
    text(value)?;
    let path = Path::new(value);
    if path.is_absolute() {
        return absolute(path);
    }
    if value.starts_with('-')
        || value.contains(['/', '\\', ':'])
        || value.chars().any(char::is_whitespace)
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(Error::Invalid("ADB入口须为绝对路径或单一程序名"));
    }
    Ok(())
}

impl Config {
    fn validate(&self) -> Result<()> {
        if self.format_version != 1 {
            return Err(Error::Invalid("配置版本必须为1"));
        }
        if let Some(adb) = &self.tools.adb {
            program(adb)?;
        }
        Ok(())
    }

    pub(crate) async fn command(&self, context: &InvocationContext) -> Result<String> {
        context.check()?;
        let executable = self
            .tools
            .adb
            .as_ref()
            .ok_or(Error::Dependency("部署者未配置ADB入口"))?;
        let path = Path::new(executable);
        if path.is_absolute() {
            paths::regular(path, context).await?;
        }
        context.check()?;
        Ok(executable.clone())
    }
}

#[cfg(test)]
mod tests;
