//! 显式操作绑定的配置、纯规则与投影，不负责注册、任务或平台副作用。
mod config;
mod mapping;
mod rules;

pub use config::{Binding, Config, FieldSource, InputMapping, ResultField, ResultMapping, Target};
pub use mapping::{map_input, map_result};

#[cfg(test)]
mod tests;
