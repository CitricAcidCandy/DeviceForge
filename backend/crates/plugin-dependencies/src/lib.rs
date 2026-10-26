//! 所有插件共用的依赖描述与纯匹配规则，不读取环境、不执行程序。
mod manifest;
mod validation;

pub use manifest::*;
pub use validation::{compatible_version, probe_version};

#[cfg(test)]
mod tests;
