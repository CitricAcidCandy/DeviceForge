//! 随宿主版本交付的插件开发知识入口，不执行插件或创建任务。
mod catalog;
mod query;
mod schema;

pub(crate) use query::get;
pub(crate) use schema::tool;

pub(crate) const TOOL_NAME: &str = "deviceforge.get_plugin_development_guide";
pub(crate) const INSTRUCTIONS: &str = "设备操作以异步任务执行。工具返回排队任务时应读取任务最终状态；需要中止时显式调用取消工具。开发 DeviceForge 前端、后端或配套插件前，先调用 deviceforge.get_plugin_development_guide，按 target 和 topic 读取当前宿主随版本发布的接口、示例、打包及验证说明。指南查询直接返回文档，不创建任务。";
