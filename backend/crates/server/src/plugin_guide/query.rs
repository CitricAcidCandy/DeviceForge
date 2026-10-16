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
        "guide_version": 1,
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
        "fullstack_workflow": "先定义服务器操作名称、对象输入模式与结果/产物格式，再由浏览器插件通过公开 HostContext.listOperations/submit/getJob 调用 plugin.<id>.<operation>，查询最终任务状态；文件使用产物 ID。前后端包分别安装和启用，浏览器插件不能直接导入服务器内部类型或选择服务器程序、路径。需要持续双向通信时使用公开会话 API 与独立协议 5，并按对应主题核对契约。"
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
