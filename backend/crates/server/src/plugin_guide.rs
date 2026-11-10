//! 宿主管理的开发知识入口，内置正文保底，显式采用兼容在线快照。
mod catalog;
mod query;
mod schema;
#[cfg(test)]
mod tests;

pub(crate) use query::{current, update};
pub(crate) use schema::{tool, update_tool};

use apk_domain::plugin_guides::GuideStore;
use std::sync::Arc;

pub(crate) const TOOL_NAME: &str = "deviceforge.get_plugin_development_guide";
pub(crate) const UPDATE_TOOL_NAME: &str = "deviceforge.update_plugin_development_guide";
const ONLINE_SOURCE: &str = "https://raw.githubusercontent.com/CitricAcidCandy/DeviceForge-SDK/main/guides/plugin-guide.json";

pub(crate) fn service(
    store: Option<Arc<dyn GuideStore>>,
    shutdown: tokio_util::sync::CancellationToken,
) -> Arc<apk_application::plugin_guides::GuideService> {
    apk_application::plugin_guides::GuideService::new(
        catalog::builtin().expect("内置指南完整且兼容"),
        store,
        shutdown,
    )
    .expect("内置指南可用")
}

pub(crate) fn online_store() -> Option<Arc<dyn GuideStore>> {
    let result = crate::configuration_home::from_environment()
        .map_err(|_| apk_domain::Error::Storage("无法确定指南缓存目录".into()))
        .and_then(|root| {
            apk_infrastructure::plugin_guides::HttpGuideStore::new(
                root.join("plugin-guides")
                    .join(format!("v{}", deviceforge_plugin_guide::GUIDE_VERSION)),
                ONLINE_SOURCE,
            )
        });
    match result {
        Ok(store) => Some(Arc::new(store)),
        Err(error) => {
            tracing::warn!(code = error.code(), "指南在线更新未配置，内置正文仍可读取");
            None
        }
    }
}
pub(crate) const INSTRUCTIONS: &str = "设备操作以异步任务执行。工具返回排队任务时应读取任务最终状态；需要中止时显式调用取消工具。开发 DeviceForge 浏览器、服务器或配套插件时，调用 deviceforge.get_plugin_development_guide，按 target 和 topic 获取开发流程、公开能力和接口、约束、生命周期、调试与发布要求。manifest 主题包含单一 manifest.json 开发清单及完整 market 数据结构，packaging 说明自动生成与发布命令。插件可在独立工程开发，无需获取宿主源码；documents.content 直接返回知识正文，不提供源码位置或文档物理地址。指南查询不联网、不创建任务；如需显式更新指南资料，使用deviceforge.update_plugin_development_guide的update操作，reset回到内置指南。资料更新不升级SDK或开放宿主新能力。";
