//! 部署者配置的严格模型；只在有效执行上下文中读取。
pub(crate) mod paths;
mod reading;
use crate::error::{Error, Result};
pub(crate) use reading::controlled;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Copy)]
pub(crate) enum Tool {
    Apkanalyzer,
    Apksigner,
    Bundletool,
    Apktool,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Entry {
    Executable { executable: String },
    JavaJar { jar: PathBuf },
}

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Tools {
    pub java: Option<String>,
    pub apkanalyzer: Option<Entry>,
    pub apksigner: Option<Entry>,
    pub bundletool: Option<Entry>,
    pub apktool: Option<Entry>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Signing {
    pub keystore: PathBuf,
    pub alias: String,
    pub store_password_file: PathBuf,
    pub key_password_file: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub format_version: u32,
    #[serde(default)]
    pub tools: Tools,
    pub signing: Option<Signing>,
    pub scratch_root: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            format_version: 1,
            tools: Tools::default(),
            signing: None,
            scratch_root: None,
        }
    }
}

fn text(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(Error::Invalid("配置字符串为空、超限或含控制符"));
    }
    Ok(())
}

fn absolute(path: &std::path::Path) -> Result<()> {
    text(path.to_str().ok_or(Error::Invalid("配置路径须为UTF-8"))?)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid("配置路径须为不含越界的绝对路径"));
    }
    Ok(())
}

fn program(value: &str) -> Result<()> {
    text(value)?;
    let path = std::path::Path::new(value);
    if !path.is_absolute()
        && (path.components().count() != 1
            || value.contains(['/', '\\'])
            || value.chars().any(char::is_whitespace)
            || value == "."
            || value == "..")
    {
        return Err(Error::Invalid("工具入口须为绝对路径或单一程序名"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

impl Config {
    pub(super) fn validate(&self) -> Result<()> {
        if self.format_version != 1 {
            return Err(Error::Invalid("配置版本必须为1"));
        }
        if let Some(java) = &self.tools.java {
            program(java)?;
        }
        for (entry, executable_allowed, jar_allowed) in [
            (&self.tools.apkanalyzer, true, false),
            (&self.tools.apksigner, true, true),
            (&self.tools.bundletool, false, true),
            (&self.tools.apktool, false, true),
        ] {
            match entry {
                None => {}
                Some(Entry::Executable { executable }) if executable_allowed => {
                    program(executable)?
                }
                Some(Entry::JavaJar { jar }) if jar_allowed => absolute(jar)?,
                _ => return Err(Error::Invalid("工具入口类型不符合配置契约")),
            }
        }
        if let Some(root) = &self.scratch_root {
            absolute(root)?;
        }
        if let Some(signing) = &self.signing {
            for path in [
                &signing.keystore,
                &signing.store_password_file,
                &signing.key_password_file,
            ] {
                absolute(path)?;
            }
            text(&signing.alias)?;
            if signing.alias.len() > 200 {
                return Err(Error::Invalid("签名别名超过200字节"));
            }
        }
        Ok(())
    }

    pub(crate) async fn command(
        &self,
        tool: Tool,
        context: &deviceforge_plugin_runtime::InvocationContext,
    ) -> Result<(String, Vec<String>)> {
        context.check()?;
        let entry = match tool {
            Tool::Apkanalyzer => &self.tools.apkanalyzer,
            Tool::Apksigner => &self.tools.apksigner,
            Tool::Bundletool => &self.tools.bundletool,
            Tool::Apktool => &self.tools.apktool,
        };
        match entry
            .as_ref()
            .ok_or(Error::Dependency("部署者未配置所需工具"))?
        {
            Entry::Executable { executable } => {
                if std::path::Path::new(executable).is_absolute() {
                    paths::regular(std::path::Path::new(executable), false, context).await?;
                }
                Ok((executable.clone(), Vec::new()))
            }
            Entry::JavaJar { jar } => {
                paths::regular(jar, false, context).await?;
                let java = self
                    .tools
                    .java
                    .as_ref()
                    .ok_or(Error::Dependency("部署者未配置Java入口"))?;
                if std::path::Path::new(java).is_absolute() {
                    paths::regular(std::path::Path::new(java), false, context).await?;
                }
                Ok((
                    java.clone(),
                    vec![
                        "-Xmx256m".into(),
                        "-jar".into(),
                        jar.to_str()
                            .ok_or(Error::Invalid("JAR路径须为UTF-8"))?
                            .into(),
                    ],
                ))
            }
        }
    }
}
