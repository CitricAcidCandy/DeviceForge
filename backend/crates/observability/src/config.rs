use std::{
    io,
    path::{Path, PathBuf},
};
use tracing::level_filters::LevelFilter;

#[derive(Clone, Debug)]
pub struct LogConfig {
    pub directory: PathBuf,
    pub queue_capacity: usize,
    pub retained_files: usize,
    pub level: LevelFilter,
}

fn number(name: &str, default: usize, minimum: usize, maximum: usize) -> io::Result<usize> {
    let value = match std::env::var(name) {
        Ok(value) => value.parse().ok(),
        Err(std::env::VarError::NotPresent) => Some(default),
        Err(_) => None,
    };
    value
        .filter(|value| (minimum..=maximum).contains(value))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{name} 必须在 {minimum} 到 {maximum} 之间"),
            )
        })
}

impl LogConfig {
    pub fn from_environment(data: &Path) -> io::Result<Self> {
        let level = match std::env::var("DEVICEFORGE_LOG_LEVEL") {
            Ok(value) => value
                .parse()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "日志等级无效"))?,
            Err(std::env::VarError::NotPresent) => LevelFilter::INFO,
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "日志等级必须为 UTF-8",
                ));
            }
        };
        let config = Self {
            directory: std::env::var_os("DEVICEFORGE_LOG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| data.join("logs")),
            queue_capacity: number("DEVICEFORGE_LOG_QUEUE", 8192, 1, 65536)?,
            retained_files: number("DEVICEFORGE_LOG_FILES", 14, 2, 365)?,
            level,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> io::Result<()> {
        if !(1..=65536).contains(&self.queue_capacity)
            || !(2..=365).contains(&self.retained_files)
            || self.directory.as_os_str().is_empty()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "日志目录、队列容量或保留文件数无效",
            ));
        }
        Ok(())
    }
}
