//! APKS 部署工具资格与绝对 ADB 解析；不构造设备业务参数。
use super::{Bundletool, Config, paths, reading::controlled};
use crate::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::path::{Path, PathBuf};

pub(crate) struct Command {
    pub executable: String,
    pub prefix: Vec<String>,
    pub adb: PathBuf,
}

impl Config {
    pub(crate) async fn apks_command(&self, context: &InvocationContext) -> Result<Command> {
        context.check()?;
        let Bundletool::JavaJar { jar } = self
            .tools
            .bundletool
            .as_ref()
            .ok_or(Error::Dependency("部署者未配置bundletool JAR"))?;
        paths::regular(jar, context).await?;
        let java = self
            .tools
            .java
            .as_ref()
            .ok_or(Error::Dependency("部署者未配置Java入口"))?;
        if Path::new(java).is_absolute() {
            paths::regular(Path::new(java), context).await?;
        }
        let adb = self
            .tools
            .adb
            .as_ref()
            .ok_or(Error::Dependency("部署者未配置ADB入口"))?;
        let adb = resolve_adb(adb, context).await?;
        context.check()?;
        Ok(Command {
            executable: java.clone(),
            prefix: vec![
                "-Xmx256m".into(),
                "-jar".into(),
                jar.to_str()
                    .ok_or(Error::Invalid("JAR路径须为UTF-8"))?
                    .into(),
            ],
            adb,
        })
    }
}

async fn resolve_adb(name: &str, context: &InvocationContext) -> Result<PathBuf> {
    let path = Path::new(name);
    let candidates = if path.is_absolute() {
        vec![path.to_path_buf()]
    } else {
        let current = std::env::current_dir().map_err(|_| Error::Io("无法定位工具查找目录"))?;
        std::env::var_os("PATH")
            .map(|value| {
                std::env::split_paths(&value)
                    .flat_map(|directory| {
                        let directory = if directory.is_absolute() {
                            directory
                        } else {
                            current.join(directory)
                        };
                        let candidate = directory.join(name);
                        if cfg!(windows) && path.extension().is_none() {
                            vec![candidate.clone(), candidate.with_extension("exe")]
                        } else {
                            vec![candidate]
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    for candidate in candidates {
        context.check()?;
        let present = controlled(context, async {
            match tokio::fs::symlink_metadata(&candidate).await {
                Ok(metadata) => Ok(metadata.is_file() || metadata.file_type().is_symlink()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(_) => Err(Error::Io("ADB入口路径无法读取")),
            }
        })
        .await?;
        if !present {
            continue;
        }
        paths::regular(&candidate, context).await?;
        let absolute = controlled(context, async {
            tokio::fs::canonicalize(&candidate)
                .await
                .map_err(|_| Error::Io("ADB入口无法解析为绝对路径"))
        })
        .await?;
        paths::regular(&absolute, context).await?;
        if absolute.to_str().is_none() {
            return Err(Error::Invalid("ADB绝对路径须为UTF-8"));
        }
        return Ok(absolute);
    }
    Err(Error::Dependency(
        "ADB入口必须为现有工具路径或PATH中的工具名称",
    ))
}
