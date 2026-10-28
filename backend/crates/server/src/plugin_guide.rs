//! 随宿主版本交付的插件开发知识入口，不执行插件或创建任务。
mod catalog;
mod query;
mod schema;

pub(crate) use query::get;
pub(crate) use schema::tool;

pub(crate) const TOOL_NAME: &str = "deviceforge.get_plugin_development_guide";
pub(crate) const INSTRUCTIONS: &str = "设备操作以异步任务执行。工具返回排队任务时应读取任务最终状态；需要中止时显式调用取消工具。开发 DeviceForge 浏览器、服务器或配套插件时，调用 deviceforge.get_plugin_development_guide，按 target 和 topic 获取开发流程、公开能力和接口、约束、生命周期、调试与发布要求。manifest 主题包含单一 manifest.json 开发清单及完整 market 数据结构，packaging 说明自动生成与发布命令。插件可在独立工程开发，无需获取宿主源码；documents.content 直接返回知识正文，不提供源码位置或文档物理地址。指南查询不创建任务。";
