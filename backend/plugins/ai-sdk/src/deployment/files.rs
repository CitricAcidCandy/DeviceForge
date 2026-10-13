use super::{Deployment, WORKER_MEMBERS};
use crate::config::Config;
use std::path::PathBuf;

impl Deployment {
    pub async fn load_config(&self) -> Result<Config, String> {
        match tokio::fs::symlink_metadata(self.config_path()).await {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("SDK部署配置须为普通文件".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("SDK旁置或显式部署配置未准备".into());
            }
            Err(_) => return Err("SDK部署配置无法检查".into()),
        }
        Config::load(self.config_path()).await
    }

    pub async fn worker_entry(&self) -> Result<PathBuf, String> {
        for directory in [self.root.join("worker"), self.worker_directory()] {
            match tokio::fs::symlink_metadata(directory).await {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                _ => return Err("SDK包内固定worker目录未准备".into()),
            }
        }
        let directory = self.worker_directory();
        for member in WORKER_MEMBERS {
            match tokio::fs::symlink_metadata(directory.join(member)).await {
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() > 0
                        && metadata.len() <= 256 * 1024 => {}
                _ => {
                    return Err(format!("SDK包内固定成员未准备或无效：worker/dist/{member}"));
                }
            }
        }
        Ok(directory.join("index.js"))
    }
}
