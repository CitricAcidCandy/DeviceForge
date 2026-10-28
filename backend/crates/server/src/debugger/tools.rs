//! 工具只映射共用调试用例；浏览器动作由已选实例执行，服务器调用保留原 Job。
use super::{ApiError, error};
use apk_application::{
    Application,
    debugger::{
        AutomationInput, DataCatalogInput, DataReadInput, DataWriteInput, DebugCommandRequest,
        DebugTarget, DebugTool, DebuggerService, EventQuery, SessionRequest, TargetKind,
    },
    plugin_lifecycle::PluginService,
};
use axum::http::StatusCode;
use rmcp::model::{Tool, ToolAnnotations};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

mod command_query;
mod diagnostics;
mod diagnostics_adapter;
pub(crate) use diagnostics_adapter::PersistentDiagnostics;
mod reload;
mod report;
#[allow(unused_imports)] // 由公共装配注入真实日志端口时使用。
pub(crate) use diagnostics::DiagnosticPage;
pub(crate) use diagnostics::{DebuggerDiagnostics, DiagnosticQuery, LogOrder};

/// 适配器只转发原 PluginService 的串行排空重载，不建立第二套生命周期。
pub(crate) type ReloadExpected = dyn Fn(
        Arc<PluginService>,
        String,
        String,
        tokio_util::sync::CancellationToken,
        apk_domain::ExecutionContext,
    ) -> futures_util::future::BoxFuture<
        'static,
        apk_domain::Result<apk_domain::plugins::PluginInfo>,
    > + Send
    + Sync;

#[derive(Default, Clone, Copy)]
pub(crate) struct DebuggerPorts<'a> {
    pub diagnostics: Option<&'a dyn DebuggerDiagnostics>,
    pub artifacts: Option<&'a dyn apk_domain::artifacts::ArtifactStore>,
    pub reload_expected: Option<&'a ReloadExpected>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum SessionInput {
    Open {
        target: DebugTarget,
    },
    Get {
        session_id: String,
    },
    Touch {
        session_id: String,
    },
    Select {
        session_id: String,
        target: DebugTarget,
    },
    Close {
        session_id: String,
    },
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CommandInput {
    session_id: String,
    #[serde(default = "empty")]
    parameters: Value,
}

#[derive(schemars::JsonSchema)]
#[allow(dead_code)] // 仅用于公开工具输入模式，执行入口继续复用 CommandInput。
struct TypedCommandInput<T: schemars::JsonSchema> {
    session_id: String,
    parameters: T,
}

fn empty() -> Value {
    json!({})
}

// 同一工具可选浏览器或服务器目标；浏览器命令和可选结果不能被服务器专用模式隐藏。
fn invocation_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["session_id","parameters"],
    "properties":{"session_id":{"type":"string"},"parameters":{"anyOf":[
        crate::openapi::schema::<super::server_target::InvokeInput>(),
        {"type":"object","additionalProperties":false,
            "required":["kind","id","input","confirmed","allow_unknown_side_effects"],
            "properties":{"kind":{"enum":["command","service"]},"id":{"type":"string"},
                "version":{"type":"string"},"input":{},"confirmed":{"type":"boolean"},
                "allow_unknown_side_effects":{"type":"boolean"},"include_result":{"type":"boolean","default":false}}}
    ]}}})
}

pub(crate) fn manages(name: &str) -> bool {
    matches!(
        name,
        "deviceforge.debug_session"
            | "deviceforge.debug_targets"
            | "deviceforge.debug_inspect"
            | "deviceforge.debug_events"
            | "deviceforge.debug_command"
            | "deviceforge.debug_data_catalog"
            | "deviceforge.debug_data_read"
            | "deviceforge.debug_data_write"
            | "deviceforge.debug_automation_run"
            | "deviceforge.debug_ui_tree"
            | "deviceforge.debug_ui_query"
            | "deviceforge.debug_ui_diff"
            | "deviceforge.debug_ui_assert"
            | "deviceforge.debug_ui_action"
            | "deviceforge.debug_invoke"
            | "deviceforge.debug_reload"
            | "deviceforge.debug_report"
    )
}

pub(crate) fn tools() -> Vec<Tool> {
    [
        (
            "debug_session",
            "打开、明确选择、续期、读取或关闭本机插件调试会话",
            crate::openapi::schema::<SessionInput>(),
            false,
        ),
        (
            "debug_targets",
            "列出本机浏览器实例和已登记插件，以及当前服务器插件；不会自动选择目标",
            json!({"type":"object","additionalProperties":false}),
            true,
        ),
        (
            "debug_inspect",
            "检查选定插件的贡献、代次和已登记资源，不读取任意私有状态",
            crate::openapi::schema::<CommandInput>(),
            true,
        ),
        (
            "debug_events",
            "查询内存会话事件，或通过 source=logs 查询服务器持久日志；筛选、倒序和游标由日志端口执行",
            crate::openapi::schema::<diagnostics::EventsInput>(),
            true,
        ),
        (
            "debug_command",
            "查询归属本会话的原命令回执；允许读取结束或换代会话的历史，不会重新派发动作",
            crate::openapi::schema::<command_query::CommandQuery>(),
            true,
        ),
        (
            "debug_data_catalog",
            "列出所选浏览器插件主动登记的数据源、模式及读写能力，不触发数据读取",
            crate::openapi::schema::<TypedCommandInput<DataCatalogInput>>(),
            true,
        ),
        (
            "debug_data_read",
            "读取所选浏览器插件的明确数据源及修订；数据正文最多256KiB，返回已知敏感字段脱敏后的业务投影",
            crate::openapi::schema::<TypedCommandInput<DataReadInput>>(),
            true,
        ),
        (
            "debug_data_write",
            "按expected_revision完整替换已登记业务投影并回读；须confirmed=true，插件原子校验修订，未知结果不重放",
            crate::openapi::schema::<TypedCommandInput<DataWriteInput>>(),
            false,
        ),
        (
            "debug_automation_run",
            "在选定浏览器连续执行1至32步，总预算30秒；绑定只引用先前唯一查询节点或数据修订，禁止嵌套、重载和自动重放",
            crate::openapi::schema::<TypedCommandInput<AutomationInput>>(),
            false,
        ),
        (
            "debug_ui_tree",
            "读取选定浏览器目标的基础结构树与覆盖范围，不把可观察节点当作扩展点",
            crate::openapi::schema::<CommandInput>(),
            true,
        ),
        (
            "debug_ui_query",
            "按语义查找当前目标节点；返回稳定节点引用和修订",
            crate::openapi::schema::<CommandInput>(),
            true,
        ),
        (
            "debug_ui_diff",
            "比较本实例目标的内存快照，不完整采集不能证明节点不存在",
            crate::openapi::schema::<CommandInput>(),
            true,
        ),
        (
            "debug_ui_assert",
            "执行结构断言，分别报告通过、失败或无法判定",
            crate::openapi::schema::<CommandInput>(),
            true,
        ),
        (
            "debug_ui_action",
            "在选定实例高亮或交互；按目标能力选择动作，保留原禁用、校验和确认，不自动重放",
            crate::openapi::schema::<CommandInput>(),
            false,
        ),
        (
            "debug_invoke",
            "显式试调用选定插件的公开入口，服务器调用仍返回原任务",
            invocation_schema(),
            false,
        ),
        (
            "debug_reload",
            "只重载明确选定的本地插件；结果未确认时不自动重试",
            crate::openapi::schema::<TypedCommandInput<reload::ReloadInput>>(),
            false,
        ),
        (
            "debug_report",
            "汇总并递归脱敏所选目标证据；显式 parameters.export=json/markdown 时写入原产物存储",
            crate::openapi::schema::<TypedCommandInput<report::ReportInput>>(),
            false,
        ),
    ]
    .into_iter()
    .map(|(name, description, schema, read_only)| {
        Tool::new(
            format!("deviceforge.{name}"),
            description,
            schema.as_object().expect("调试工具输入是对象").clone(),
        )
        .with_annotations(
            ToolAnnotations::default()
                .read_only(read_only)
                .destructive(!read_only && name != "debug_report")
                .idempotent(false)
                .open_world(!read_only),
        )
    })
    .collect()
}

pub(super) fn decode<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, ApiError> {
    serde_json::from_value(input).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "调试参数不符合当前工具模式，请核对必填目标、会话 ID 和字段类型",
        )
    })
}

fn encode(value: impl serde::Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "debugger_encoding_failed",
            "调试结果无法编码；业务运行不受影响",
        )
    })
}

fn validate_server_target(
    target: &DebugTarget,
    plugins: Option<&Arc<PluginService>>,
) -> Result<(), ApiError> {
    if target.target_kind != TargetKind::Server {
        return Ok(());
    }
    let found = plugins.and_then(|plugins| {
        plugins
            .list()
            .into_iter()
            .find(|plugin| plugin.id == target.plugin_id)
    });
    if !found.is_some_and(|plugin| target.generation.as_deref() == Some(plugin.generation.as_str()))
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_target_changed",
            "所选服务器插件不存在或运行代次已变化，请重新查询目标并选择当前代次",
        ));
    }
    Ok(())
}

pub(crate) async fn invoke_with_ports(
    app: &Arc<Application>,
    plugins: Option<&Arc<PluginService>>,
    debugger: &Arc<DebuggerService>,
    ports: DebuggerPorts<'_>,
    name: &str,
    input: Value,
) -> Result<Value, ApiError> {
    if !manages(name) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "debugger_tool_unknown",
            "当前宿主不支持此调试工具，请查询能力清单",
        ));
    }
    match name {
        "deviceforge.debug_targets" => {
            if input != json!({}) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "debugger_invalid_input",
                    "目标查询不接收筛选外的额外字段",
                ));
            }
            let browsers = debugger.targets().map_err(error)?;
            let instances = debugger.instances().map_err(error)?;
            let servers = plugins.map(|plugins| plugins.list()).unwrap_or_default();
            Ok(
                json!({"protocol_version":1,"browser_instances":instances,"browser_targets":browsers,"server_plugins":servers}),
            )
        }
        "deviceforge.debug_session" => {
            let input: SessionInput = decode(input)?;
            match input {
                SessionInput::Open { target } => {
                    validate_server_target(&target, plugins)?;
                    encode(
                        debugger
                            .open_session(SessionRequest { target })
                            .map_err(error)?,
                    )
                }
                SessionInput::Get { session_id } => {
                    encode(debugger.session(&session_id).map_err(error)?)
                }
                SessionInput::Touch { session_id } => {
                    encode(debugger.touch_session(&session_id).map_err(error)?)
                }
                SessionInput::Select { session_id, target } => {
                    validate_server_target(&target, plugins)?;
                    encode(debugger.select_target(&session_id, target).map_err(error)?)
                }
                SessionInput::Close { session_id } => {
                    encode(debugger.close_session(&session_id).map_err(error)?)
                }
            }
        }
        "deviceforge.debug_events" => diagnostics::events(debugger, ports.diagnostics, input).await,
        "deviceforge.debug_command" => command_query::query(debugger, input),
        _ => {
            let input: CommandInput = decode(input)?;
            if let Some(suffix) = name.strip_prefix("deviceforge.debug_") {
                if matches!(
                    suffix,
                    "data_catalog" | "data_read" | "data_write" | "automation_run"
                ) {
                    let tool: DebugTool = decode(json!(suffix))?;
                    apk_application::debugger::validate_debug_command(tool, &input.parameters)
                        .map_err(error)?;
                }
            }
            let session = debugger.touch_session(&input.session_id).map_err(error)?;
            if name == "deviceforge.debug_report" {
                if session.target.target_kind == TargetKind::Server {
                    validate_server_target(&session.target, plugins)?;
                }
                return report::report(app, plugins, debugger, ports, session, input.parameters)
                    .await;
            }
            if session.target.target_kind == TargetKind::Server {
                validate_server_target(&session.target, plugins)?;
                if name == "deviceforge.debug_reload" {
                    return reload::reload(
                        plugins,
                        debugger,
                        ports.reload_expected,
                        session,
                        input.parameters,
                    )
                    .await;
                }
                if name == "deviceforge.debug_inspect" {
                    if input.parameters != json!({}) {
                        return Err(ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "debugger_invalid_input",
                            "服务器插件检查不接收额外参数",
                        ));
                    }
                    return Ok(report::redact(report::inspect(
                        app,
                        plugins,
                        &session.target,
                    )?));
                }
                if name == "deviceforge.debug_invoke" {
                    return super::server_target::invoke(app, &session.target, input.parameters)
                        .await;
                }
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "debugger_capability_unavailable",
                    "此服务器目标尚未接入该调试动作；界面、登记数据与步骤工具需要明确选择浏览器实例，服务器数据仍通过原公开任务与服务入口读取或修改",
                ));
            }
            if name == "deviceforge.debug_reload" {
                return reload::browser_reload(debugger, session, input.parameters).await;
            }
            let suffix = name
                .strip_prefix("deviceforge.debug_")
                .expect("已经检查工具名");
            let tool: DebugTool = decode(json!(suffix))?;
            encode(
                debugger
                    .execute(DebugCommandRequest {
                        session_id: input.session_id,
                        tool,
                        parameters: input.parameters,
                    })
                    .await
                    .map_err(error)?,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debugger_tools_are_unique_and_mutations_are_not_marked_read_only() {
        let tools = tools();
        assert_eq!(tools.len(), 17);
        let names = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(names.len(), tools.len());
        for tool in tools {
            assert!(manages(&tool.name));
            assert!(!tool.name.contains("install") && !tool.name.contains("upload"));
            let writes = matches!(
                tool.name.as_ref(),
                "deviceforge.debug_session"
                    | "deviceforge.debug_ui_action"
                    | "deviceforge.debug_invoke"
                    | "deviceforge.debug_reload"
                    | "deviceforge.debug_report"
                    | "deviceforge.debug_data_write"
                    | "deviceforge.debug_automation_run"
            );
            assert_eq!(tool.annotations.unwrap().read_only_hint, Some(!writes));
        }
    }

    #[test]
    fn debugger_invoke_schema_exposes_browser_command_and_optional_result() {
        let schema = invocation_schema();
        let alternatives = schema["properties"]["parameters"]["anyOf"]
            .as_array()
            .unwrap();
        assert_eq!(alternatives.len(), 2);
        assert!(
            alternatives[1]["properties"]["kind"]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "command")
        );
        assert_eq!(
            alternatives[1]["properties"]["include_result"]["default"],
            false
        );
        assert_eq!(alternatives[1]["additionalProperties"], false);
    }

    #[test]
    fn debugger_data_and_automation_schemas_expose_actual_fields() {
        let tools = tools();
        for (name, fields) in [
            ("deviceforge.debug_data_read", vec!["source_id", "query"]),
            (
                "deviceforge.debug_data_write",
                vec!["source_id", "expected_revision", "value", "confirmed"],
            ),
            (
                "deviceforge.debug_automation_run",
                vec![
                    "steps",
                    "confirmed",
                    "stop_on_failure",
                    "target_from_step",
                    "revision_from_step",
                ],
            ),
            (
                "deviceforge.debug_command",
                vec!["session_id", "command_id"],
            ),
        ] {
            let tool = tools.iter().find(|tool| tool.name == name).unwrap();
            let schema = serde_json::to_string(&tool.input_schema).unwrap();
            for field in fields {
                assert!(schema.contains(field), "{name} 缺少 {field}");
            }
        }
    }

    #[tokio::test]
    async fn debugger_server_data_and_automation_explicitly_report_unavailable() {
        let (app, plugins, target) = super::super::server_target::tests::fixture().await;
        let debugger = Arc::new(DebuggerService::new());
        let session = debugger.open_session(SessionRequest { target }).unwrap();
        for (name, parameters) in [
            ("data_catalog", json!({})),
            ("data_read", json!({"source_id":"aliases"})),
            (
                "data_write",
                json!({"source_id":"aliases","expected_revision":"r1","value":{},"confirmed":true}),
            ),
            (
                "automation_run",
                json!({"steps":[{"id":"inspect","tool":"inspect","parameters":{}}],"confirmed":false}),
            ),
        ] {
            let result = invoke_with_ports(
                &app,
                Some(&plugins),
                &debugger,
                DebuggerPorts::default(),
                &format!("deviceforge.debug_{name}"),
                json!({"session_id":session.session_id,"parameters":parameters}),
            )
            .await;
            assert!(result.is_err(), "服务器目标不能伪造{name}成功");
            if let Err(error) = result {
                assert_eq!(error.1.code, "debugger_capability_unavailable");
            }
        }
    }
}
