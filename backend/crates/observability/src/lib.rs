//! 宿主公共可观测性，不依赖业务模块或插件 SDK。
mod config;
mod context;
mod logging;

pub use config::LogConfig;
pub use context::LogContext;
pub use logging::{LogMetrics, LogRuntime, LogStats, install};
