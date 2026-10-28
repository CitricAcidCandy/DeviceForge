//! 独立手工帧与假ADB真实进程；不引用生产解析器、不代表真机或共享server验收。
mod support;

#[path = "cases/install_apks.rs"]
mod install_apks;

#[path = "cases/performance.rs"]
mod performance;

#[path = "cases/performance_fps.rs"]
mod performance_fps;

#[path = "cases/performance_environment.rs"]
mod performance_environment;

#[path = "cases/artifact_lifetime.rs"]
mod artifact_lifetime;
#[path = "cases/artifact_validation.rs"]
mod artifact_validation;
#[path = "cases/configuration.rs"]
mod configuration;
#[path = "cases/discovery.rs"]
mod discovery;
#[path = "cases/installation.rs"]
mod installation;
#[path = "cases/lifetime.rs"]
mod lifetime;
#[path = "cases/normal.rs"]
mod normal;
#[path = "cases/output.rs"]
mod output;
#[path = "cases/screenshots.rs"]
mod screenshots;
#[path = "cases/start_failure.rs"]
mod start_failure;
#[path = "cases/validation.rs"]
mod validation;
