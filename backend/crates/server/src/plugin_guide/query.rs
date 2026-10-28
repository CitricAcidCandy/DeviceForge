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
        "guide_version": 4,
        "host_version": env!("CARGO_PKG_VERSION"),
        "frontend_sdk_version": 2,
        "backend_task_protocol_versions": [
            apk_plugin_sdk::PROTOCOL_VERSION,
            apk_plugin_sdk::ARTIFACT_PROTOCOL_VERSION,
            apk_plugin_sdk::cooperative::COOPERATIVE_PROTOCOL_VERSION,
            apk_plugin_sdk::CONTEXT_PROTOCOL_VERSION,
            apk_plugin_sdk::services::SERVICE_PROTOCOL_VERSION
        ],
        "backend_session_protocol_versions": [apk_plugin_sdk::session::SESSION_PROTOCOL_VERSION],
        "target": input.target,
        "topic": input.topic,
        "documents": catalog::select(input.target, input.topic),
        "available_topics": TOPICS,
        "release_format_versions": [1, 2],
        "release_host_api_versions": [2],
        "authoring_manifest_versions": [1],
        "authoring_cli_commands": ["plugin pack", "plugin plan", "plugin publish"],
        "fullstack_workflow": "先定义服务器操作、对象输入模式与结果/产物格式；服务器组件保持便携包格式，浏览器组件保持 SDK v2 ESM 格式。新完整发布使用 release.json(format_version=2,host_api_version=2) 与统一 dependencies；独立组件在包根携带 dependencies.json，v1 保留读取兼容。一次插件安装先检测后端电脑环境及 DEVICEFORGE_USER_DIR（默认 ~/.deviceforge）共享仓库，兼容工具零下载复用，只自动下载缺失必需项；启动及重新检测不下载，面板安装用于失败重试与可选项。市场优先、声明的官方 HTTPS 来源兜底，完整性失败不可换源掩盖；固定平台、版本、摘要、大小和入口，原样保留用户手动配置，自动绑定仅写 DEVICEFORGE_PLUGIN_RESOURCES 指向的有效快照。缺依赖为 dependencies_required，缺账号等输入为 configuration_required。在线发布先查市场 /api/v1/capabilities，资源先上传、清单后上传、catalog 最后提交；主 npm 包不包含工具。HTTP/MCP/CLI 共用依赖用例，target.kind 为 release/server/browser，所属组件归并完整发布。浏览器不直接执行本机工具，使用公开 HostContext 调用服务器操作并查询终态。协议 5 独立；旧单组件入口不能拆装完整发布所属组件。"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authoring_manifest_and_market_are_directly_documented() {
        for target in ["frontend", "backend"] {
            let response = get(json!({"target": target, "topic": "manifest"})).unwrap();
            assert_eq!(response["authoring_manifest_versions"], json!([1]));
            assert_eq!(
                response["authoring_cli_commands"],
                json!(["plugin pack", "plugin plan", "plugin publish"])
            );
            let content = response["documents"][0]["content"].as_str().unwrap();
            for term in [
                "manifest_version",
                "market 数据结构",
                "summary",
                "categories",
                "supports_mcp",
                "supports_agent",
                "restart_policy",
                "resource_id",
                "SHA-256",
            ] {
                assert!(content.contains(term), "{target} 缺少 {term}");
            }
        }
    }

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
                    let fields = document.as_object().unwrap();
                    assert_eq!(fields.len(), 3);
                    assert!(fields.contains_key("target"));
                    assert!(fields.contains_key("topic"));
                    assert!(fields.contains_key("content"));
                    assert!(!document["content"].as_str().unwrap().trim().is_empty());
                }
            }
        }
        let default = get(json!({"target": "backend"})).unwrap();
        assert_eq!(default["topic"], "overview");
        assert_eq!(default["backend_session_protocol_versions"], json!([5]));
    }

    #[test]
    fn configuration_fields_and_post_installation_inputs_are_documented() {
        for target in ["frontend", "backend"] {
            let response = get(json!({"target":target,"topic":"manifest"})).unwrap();
            let content = response["documents"][0]["content"].as_str().unwrap();
            for term in [
                "4294967295",
                "next_invocation",
                "plugin_reload",
                "legacy_filename",
                "defaults:{}",
                "requirements",
            ] {
                assert!(content.contains(term), "{target} 配置知识缺少 {term}");
            }
            let normalized = content.replace("\r\n", "\n");
            let example = normalized
                .split("```json\n")
                .skip(1)
                .map(|block| block.split("```").next().unwrap())
                .filter_map(|block| serde_json::from_str::<Value>(block).ok())
                .find(|value| value["requirements"][0]["config_pointer"] == "/configUrl")
                .expect("应直接提供安装后配置输入示例");
            let configuration: apk_plugin_sdk::ConfigurationDefinition =
                serde_json::from_value(example["components"][0]["plugin"]["configuration"].clone())
                    .unwrap();
            assert_eq!(configuration.defaults, json!({}));
            assert_eq!(configuration.schema["required"], json!(["configUrl"]));
            assert_eq!(
                example["requirements"][0]["component_id"],
                example["components"][0]["id"]
            );
        }
    }

    #[test]
    fn embedded_service_docs_are_self_contained() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "frontend",
                "sdk",
                &[
                    "whenAvailable",
                    "callTyped",
                    "interface ServiceFeatureDiagnostic",
                ],
            ),
            (
                "frontend",
                "lifecycle",
                &["30 秒", "10 秒", "5 秒", "cleanupErrors", "同步死循环"],
            ),
            (
                "frontend",
                "examples",
                &["service-consumer.mjs", "guide_service_consumer.status"],
            ),
            (
                "backend",
                "manifest",
                &["protocol_version=6", "services: None"],
            ),
        ];
        for (target, topic, terms) in cases {
            let response = get(json!({"target": target, "topic": topic})).unwrap();
            assert_eq!(response["guide_version"], 4);
            assert_eq!(
                response["backend_task_protocol_versions"],
                json!([1, 2, 3, 4, 6])
            );
            let content = response["documents"][0]["content"].as_str().unwrap();
            for term in *terms {
                assert!(content.contains(term), "{target}/{topic} 缺少 {term}");
            }
        }
    }

    #[test]
    fn frontend_overview_and_examples_explain_actual_ui_locations() {
        let overview = get(json!({"target":"frontend"})).unwrap();
        let content = overview["documents"][0]["content"].as_str().unwrap();
        for term in [
            "devices.apps",
            "settings.plugin.section",
            "route.settings",
            "route.marketplace",
            "侧栏",
            "每行",
        ] {
            assert!(content.contains(term), "默认知识遗漏界面能力：{term}");
        }
        assert!(!content.contains("不自动创建左侧导航或路由"));
        assert!(!content.contains("当前产品装配的具名插槽为 `workshop.extensions`"));
        let examples = get(json!({"target":"frontend", "topic":"examples"})).unwrap();
        let content = examples["documents"][0]["content"].as_str().unwrap();
        for term in [
            "slot: 'devices.apps'",
            "mode: 'append'",
            "mode: 'replace'",
            "每行",
            "mount",
        ] {
            assert!(content.contains(term), "界面示例缺少：{term}");
        }
    }
}
