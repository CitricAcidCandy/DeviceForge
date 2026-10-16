mod files;

use std::path::{Path, PathBuf};

pub const WORKER_MEMBERS: [&str; 5] = [
    "index.js",
    "probe.js",
    "protocol.js",
    "sdk.js",
    "shutdown.js",
];

#[derive(Clone, Debug)]
pub struct Deployment {
    root: PathBuf,
    config: PathBuf,
}

impl Deployment {
    pub fn current(arguments: &[String]) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| "SDK固定插件入口不可用")?;
        let managed = apk_plugin_sdk::configuration::managed_config_path();
        let mut deployment =
            Self::from_executable(&executable, if managed.is_some() { &[] } else { arguments })?;
        if let Some(path) = managed {
            if !path.is_absolute() {
                return Err("SDK宿主管理配置须为绝对路径".into());
            }
            deployment.config = path;
        }
        Ok(deployment)
    }

    pub fn from_executable(executable: &Path, arguments: &[String]) -> Result<Self, String> {
        if !executable.is_absolute() || executable.file_name().is_none() {
            return Err("SDK固定插件入口须为绝对文件路径".into());
        }
        let root = executable.parent().ok_or("SDK固定包目录不可用")?.to_owned();
        let config = match arguments {
            [] => root.join("ai-sdk.config.json"),
            [option, path] if option == "--config" => {
                let config = PathBuf::from(path);
                if !config.is_absolute() || path.contains('\0') {
                    return Err("SDK部署配置参数须为绝对路径".into());
                }
                config
            }
            _ => return Err("SDK部署入口只接受可选的--config绝对路径".into()),
        };
        Ok(Self { root, config })
    }

    pub fn config_path(&self) -> &Path {
        &self.config
    }

    pub fn worker_directory(&self) -> PathBuf {
        self.root.join("worker").join("dist")
    }
}

#[cfg(test)]
#[path = "deployment/tests.rs"]
mod tests;
