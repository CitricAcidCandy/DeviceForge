//! 参数校验与版本化指南响应，保持查询无副作用。
use super::{
    catalog,
    schema::{Input, TOPICS},
};
use apk_domain::{Error, Result};
use serde_json::{Value, json};

pub(crate) fn get(input: Value) -> Result<Value> {
    let input: Input = serde_json::from_value(input)
        .map_err(|error| Error::Invalid(format!("插件指南参数无效：{error}")))?;
    Ok(json!({
        "guide_version": 3,
        "host_version": env!("CARGO_PKG_VERSION"),
        "frontend_sdk_version": 2,
        "backend_task_protocol_versions": [
            apk_plugin_sdk::PROTOCOL_VERSION,
            apk_plugin_sdk::ARTIFACT_PROTOCOL_VERSION,
            apk_plugin_sdk::cooperative::COOPERATIVE_PROTOCOL_VERSION,
            apk_plugin_sdk::CONTEXT_PROTOCOL_VERSION
        ],
        "backend_session_protocol_versions": [apk_plugin_sdk::session::SESSION_PROTOCOL_VERSION],
        "target": input.target,
        "topic": input.topic,
        "documents": catalog::select(input.target, input.topic),
        "available_topics": TOPICS,
        "release_format_versions": [1, 2],
        "release_host_api_versions": [2],
        "fullstack_workflow": "先定义服务器操作、对象输入模式与结果/产物格式；服务器组件保持便携包格式，浏览器组件保持 SDK v2 ESM 格式。新完整发布使用 release.json(format_version=2,host_api_version=2) 与统一 dependencies；独立组件在包根携带 dependencies.json，v1 保留读取兼容。一次插件安装先检测后端电脑环境及 DEVICEFORGE_USER_DIR（默认 ~/.deviceforge）共享仓库，兼容工具零下载复用，只自动下载缺失必需项；启动及重新检测不下载，面板安装用于失败重试与可选项。市场优先、声明的官方 HTTPS 来源兜底，完整性失败不可换源掩盖；固定平台、版本、摘要、大小和入口，原样保留用户手动配置，自动绑定仅写 DEVICEFORGE_PLUGIN_RESOURCES 指向的有效快照。缺依赖为 dependencies_required，缺账号等输入为 configuration_required。在线发布先查市场 /api/v1/capabilities，资源先上传、清单后上传、catalog 最后提交；主 npm 包不包含工具。HTTP/MCP/CLI 共用依赖用例，target.kind 为 release/server/browser，所属组件归并完整发布。浏览器不直接执行本机工具，使用公开 HostContext 调用服务器操作并查询终态。协议 5 独立；旧单组件入口不能拆装完整发布所属组件。"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_reject_unknown_fields_nulls_and_wrong_types() {
        for invalid in [
            json!({}),
            json!(null),
            json!([]),
            json!({"target": null}),
            json!({"target": 1}),
            json!({"target": "other"}),
            json!({"target": "frontend", "topic": null}),
            json!({"target": "frontend", "topic": 2}),
            json!({"target": "frontend", "topic": "other"}),
            json!({"target": "backend", "path": "source.rs"}),
        ] {
            assert!(matches!(get(invalid), Err(Error::Invalid(_))));
        }
    }

    #[test]
    fn all_topics_are_embedded_for_each_target() {
        for topic in TOPICS {
            for (target, count) in [("frontend", 1), ("backend", 1), ("fullstack", 2)] {
                let response = get(json!({"target": target, "topic": topic})).unwrap();
                let documents = response["documents"].as_array().unwrap();
                assert_eq!(documents.len(), count);
                for document in documents {
                    assert_eq!(document["topic"], json!(topic));
                    assert!(document["source"].as_str().unwrap().ends_with(".md"));
                    assert!(!document["content"].as_str().unwrap().trim().is_empty());
                }
            }
        }
        let default = get(json!({"target": "backend"})).unwrap();
        assert_eq!(default["topic"], "overview");
        assert_eq!(default["backend_session_protocol_versions"], json!([5]));
    }
}
