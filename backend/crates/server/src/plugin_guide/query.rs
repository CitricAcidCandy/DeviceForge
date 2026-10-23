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
        "guide_version": 2,
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
        "release_format_versions": [1],
        "release_host_api_versions": [2],
        "fullstack_workflow": "先定义服务器操作、对象输入模式与结果/产物格式；服务器组件保持便携包格式，浏览器组件保持 SDK v2 ESM 格式，通过 release.json(format_version=1,host_api_version=2) 将两类独立组件和必需工具组成一个功能发布。在线发布先确认资源服务器 GET /api/v1/capabilities 支持，随后资源先上传、清单后上传、catalog 最后提交；离线 ZIP 根包含 release.json 和全部引用资源。宿主统一计划、安装、配置、启停与按修订更新，启用意图持久化；缺必填输入为 configuration_required。文件与配置落在宿主用户根，托管工具通过 DEVICEFORGE_PLUGIN_RESOURCES 与 SDK 获取；托管绑定只改变有效配置，用户高级显式路径优先且原值保留。浏览器使用公开 HostContext.listOperations/submit/getJob 调用 plugin.<id>.<operation> 并查询终态，文件使用产物 ID；不能导入服务器私有类型或选择程序路径。协议 5 仍为独立会话契约。旧单组件安装与加载入口仅作兼容，不用它拆装统一发布所属组件。"
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
