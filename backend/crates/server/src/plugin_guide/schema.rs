//! 指南工具的严格参数和 MCP 发现元数据。
use rmcp::model::{Tool, ToolAnnotations};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Target {
    Frontend,
    Backend,
    Fullstack,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Topic {
    #[default]
    Overview,
    Manifest,
    Sdk,
    Lifecycle,
    Examples,
    Packaging,
    Dependencies,
    Validation,
}

pub(super) const TOPICS: [Topic; 8] = [
    Topic::Overview,
    Topic::Manifest,
    Topic::Sdk,
    Topic::Lifecycle,
    Topic::Examples,
    Topic::Packaging,
    Topic::Dependencies,
    Topic::Validation,
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    pub target: Target,
    #[serde(default)]
    pub topic: Topic,
}

pub(crate) fn tool() -> Tool {
    let schema = json!({
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["frontend", "backend", "fullstack"],
                "description": "开发浏览器插件、服务器插件或前后端配套插件"},
            "topic": {"type": "string", "enum": TOPICS, "default": "overview",
                "description": "按需读取开发流程与能力概览；manifest 含单一开发清单和完整 market 结构，packaging 含自动打包发布命令；另有公开接口、生命周期、完整示例、共享依赖和调试验证"}
        },
        "required": ["target"],
        "additionalProperties": false
    });
    Tool::new(
        super::TOOL_NAME,
        "开发 DeviceForge 插件时读取此指南，无需获取宿主源码。直接返回开发流程、公开能力和接口、约束、生命周期、调试与发布要求，包含独立工程示例；不提供源码位置或文档物理地址。只读、幂等，不执行代码、不创建任务。",
        schema.as_object().expect("固定指南模式为对象").clone(),
    )
    .with_annotations(
        ToolAnnotations::default()
            .read_only(true)
            .destructive(false)
            .idempotent(true)
            .open_world(false),
    )
}
