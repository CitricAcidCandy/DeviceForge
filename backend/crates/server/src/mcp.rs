use apk_application::Application;
use apk_application::plugin_lifecycle::PluginService;
use apk_domain::plugins::PluginInput;
use apk_domain::{Error, Result};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
#[derive(Clone)]
struct McpAdapter {
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobInput {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventInput {
    id: String,
    #[serde(default)]
    after: u64,
}
fn encode(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Dependency(e.to_string()))
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| Error::Invalid(e.to_string()))
}
impl McpAdapter {
    fn new(
        app: Arc<Application>,
        plugins: Option<Arc<PluginService>>,
        devices: Arc<apk_application::devices::DeviceService>,
    ) -> Self {
        Self {
            app,
            plugins,
            devices,
        }
    }
    fn plugin_service(&self) -> Result<&Arc<PluginService>> {
        self.plugins
            .as_ref()
            .ok_or_else(|| Error::Dependency("插件管理服务未配置".into()))
    }
    async fn invoke(&self, name: &str, input: Value) -> Result<Value> {
        match name {
            "deviceforge.list_device_providers"
            | "deviceforge.list_devices"
            | "deviceforge.refresh_devices"
            | "deviceforge.invoke_device" => {
                crate::device_mcp::invoke(&self.devices, name, input).await
            }
            "deviceforge.list_operations" => {
                if input != json!({}) {
                    return Err(Error::Invalid("此工具不接收参数".into()));
                }
                encode(self.app.operations())
            }
            "deviceforge.get_job" => {
                let input: JobInput = decode(input)?;
                encode(self.app.get_async(input.id).await?)
            }
            "deviceforge.cancel_job" => {
                let input: JobInput = decode(input)?;
                encode(self.app.cancel_async(input.id).await?)
            }
            "deviceforge.job_events" => {
                let input: EventInput = decode(input)?;
                encode(self.app.events_async(input.id, input.after).await?)
            }
            "deviceforge.list_plugins" => {
                if input != json!({}) {
                    return Err(Error::Invalid("此工具不接收参数".into()));
                }
                encode(self.plugin_service()?.list())
            }
            "deviceforge.load_plugin" => {
                let input: PluginInput = decode(input)?;
                encode(self.plugin_service()?.load(input.id).await?)
            }
            "deviceforge.unload_plugin" => {
                let input: PluginInput = decode(input)?;
                encode(self.plugin_service()?.unload(input.id).await?)
            }
            operation => encode(self.app.submit_async(operation.into(), input).await?),
        }
    }
}
impl ServerHandler for McpAdapter {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("deviceforge", env!("CARGO_PKG_VERSION")))
            .with_instructions("设备操作以异步任务执行。工具返回排队任务时应读取任务最终状态；需要中止时显式调用取消工具。")
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        let (revision, tools) = crate::mcp_tools::catalog(&self.app, self.plugins.is_some());
        let start = match request.and_then(|request| request.cursor) {
            None => 0,
            Some(cursor) => {
                let (version, offset) = cursor
                    .split_once(':')
                    .ok_or_else(|| ErrorData::invalid_params("工具游标无效", None))?;
                let version = version
                    .parse::<u64>()
                    .map_err(|_| ErrorData::invalid_params("工具游标无效", None))?;
                if version != revision {
                    return Err(ErrorData::invalid_params(
                        "工具目录已变化，请重新分页",
                        None,
                    ));
                }
                offset
                    .parse::<usize>()
                    .map_err(|_| ErrorData::invalid_params("工具游标无效", None))?
            }
        };
        if start > tools.len() {
            return Err(ErrorData::invalid_params("工具游标越界", None));
        }
        let end = start.saturating_add(100).min(tools.len());
        let result = ListToolsResult {
            tools: tools[start..end].to_vec(),
            next_cursor: (end < tools.len()).then(|| format!("{revision}:{end}")),
            ttl_ms: Some(0),
            cache_scope: Some(rmcp::model::CacheScope::Private),
            ..Default::default()
        };
        Ok(result)
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.app
            .operation(name)
            .map(crate::mcp_tools::operation_tool)
            .or_else(|| {
                crate::mcp_tools::management_tools(self.plugins.is_some())
                    .into_iter()
                    .chain(crate::device_mcp::tools())
                    .find(|tool| tool.name == name)
            })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let input = Value::Object(request.arguments.unwrap_or_default());
        let result = match self.invoke(&request.name, input).await {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => {
                let api_error: crate::ApiError = error.into();
                CallToolResult::structured_error(
                    json!({"code":api_error.1.code,"message":api_error.1.message}),
                )
            }
        };
        Ok(result.into())
    }
}
pub fn service(
    app: Arc<Application>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    service_with_plugins(app, None, config)
}
pub(crate) fn service_with_plugins(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    let devices = apk_application::devices::DeviceService::new(app.clone());
    service_with_devices(app, plugins, devices, config)
}
pub(crate) fn service_with_devices(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    let handler = crate::mcp_observability::Observed(McpAdapter::new(app, plugins, devices));
    StreamableHttpService::new(
        move || Ok(handler.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    )
}
pub fn default_config() -> StreamableHttpServerConfig {
    let mut config = StreamableHttpServerConfig::default().enforce_origin_validation();
    config.legacy_session_mode = false;
    config.json_response = true;
    config.max_request_body_bytes = 256 * 1024;
    config
}
