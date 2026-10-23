//! MCP 工具发现读取当前注册快照；开发指南常驻，插件管理工具按装配贡献。
use apk_application::Application;
use rmcp::model::Tool;
use serde_json::json;

pub(crate) fn catalog(app: &Application, management: bool) -> (u64, Vec<Tool>) {
    let (revision, operations, sessions) = app.contributions_snapshot();
    let mut tools: Vec<_> = operations.into_iter().map(operation_tool).collect();
    tools.extend(
        sessions
            .into_iter()
            .map(crate::interactive_mcp::session_tool),
    );
    tools.extend(crate::interactive_mcp::tools());
    tools.extend(management_tools(management));
    tools.extend(crate::device_mcp::tools());
    (revision, tools)
}
pub(crate) fn operation_tool(operation: apk_domain::Operation) -> Tool {
    let description = format!(
        "{}。提交后返回任务 ID；使用 deviceforge.get_job 查询最终结果，使用 deviceforge.cancel_job 取消。",
        operation.title
    );
    Tool::new(
        operation.id,
        description,
        operation
            .input_schema
            .as_object()
            .expect("注册层要求对象模式")
            .clone(),
    )
}
pub(crate) fn management_tools(management: bool) -> Vec<Tool> {
    let mut tools = vec![crate::plugin_guide::tool()];
    let job = json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false});
    for (name, description, schema) in [
        (
            "deviceforge.list_operations",
            "列出当前内置与插件操作及输入模式",
            json!({"type":"object","additionalProperties":false}),
        ),
        (
            "deviceforge.get_job",
            "读取任务状态、最终结果或失败原因",
            job.clone(),
        ),
        (
            "deviceforge.cancel_job",
            "取消排队或执行中的任务；已结束任务保持原结果",
            job.clone(),
        ),
        (
            "deviceforge.job_events",
            "按递增游标读取任务状态事件，每次最多 200 条",
            json!({"type":"object","properties":{"id":{"type":"string"},"after":{"type":"integer","minimum":0}},"required":["id"],"additionalProperties":false}),
        ),
    ] {
        tools.push(Tool::new(
            name,
            description,
            schema.as_object().unwrap().clone(),
        ));
    }
    if management {
        for (name, description, schema) in [
            (
                "deviceforge.list_plugins",
                "列出已加载或正在排空的服务器插件及代际",
                json!({"type":"object","additionalProperties":false}),
            ),
            (
                "deviceforge.load_plugin",
                "加载管理员已部署的插件，只接受插件 ID",
                job.clone(),
            ),
            (
                "deviceforge.unload_plugin",
                "撤销插件贡献，取消并等待在途任务；受保护插件拒绝卸载",
                job.clone(),
            ),
            (
                "deviceforge.plugin_recovery_status",
                "读取插件资源核对状态和当前代际",
                job,
            ),
            (
                "deviceforge.recover_plugin",
                "按当前代际核对并恢复资源，不重放业务或终止活跃会话",
                json!({"type":"object","additionalProperties":false,
                    "properties":{"id":{"type":"string"},"generation":{"type":"string"},"input":{"type":"object"}},
                    "required":["id","generation","input"]}),
            ),
        ] {
            tools.push(Tool::new(
                name,
                description,
                schema.as_object().unwrap().clone(),
            ));
        }
    }
    tools
}
