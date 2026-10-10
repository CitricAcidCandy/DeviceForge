//! 独立原帧与假HDC真实进程；不调用生产解析器，不代表真机验收。
mod support;

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
#[path = "cases/validation.rs"]
mod validation;
