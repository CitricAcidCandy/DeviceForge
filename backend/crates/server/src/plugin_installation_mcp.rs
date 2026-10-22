//! 只读安装查询工具；安装变更由统一任务操作自动暴露。
use rmcp::model::Tool;
pub(super) fn tools() -> Vec<Tool> {
    [
        ("deviceforge.list_plugin_installations", "列出完整功能插件的持久安装和启停状态", serde_json::json!({"type":"object","additionalProperties":false})),
        ("deviceforge.plan_plugin_installation", "预览完整功能插件依赖、兼容性和复用计划", crate::openapi::schema::<apk_domain::plugin_installations::InstallSource>()),
    ].into_iter().map(|(name,description,schema)| Tool::new(name,description,schema.as_object().expect("公开输入模式为对象").clone())).collect()
}
