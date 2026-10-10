//! 独立手工帧与假ADB真实进程；不引用生产解析器、不代表真机或共享server验收。
mod support;

#[path = "cases/configuration.rs"]
mod configuration;
#[path = "cases/discovery.rs"]
mod discovery;
#[path = "cases/lifetime.rs"]
mod lifetime;
#[path = "cases/normal.rs"]
mod normal;
#[path = "cases/output.rs"]
mod output;
#[path = "cases/validation.rs"]
mod validation;
