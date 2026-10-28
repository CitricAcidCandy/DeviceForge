use apk_application::Application;
use apk_application::plugin_lifecycle::PluginService;
use apk_domain::plugins::PluginInput;
use apk_domain::{Error, Result};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, SubscriptionFilter, Tool,
    },
    service::{RequestContext, SubscriptionContext},
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
    debugger: Arc<apk_application::debugger::DebuggerService>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    dependencies: Option<Arc<apk_application::plugin_dependencies::DependencyService>>,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    logging: Option<deviceforge_observability::LogMetrics>,
    notifications: Arc<crate::mcp_notifications::CatalogNotifications>,
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
        shutdown: tokio_util::sync::CancellationToken,
    ) -> Self {
        Self {
            debugger: Arc::new(apk_application::debugger::DebuggerService::default()),
            app,
            plugins,
            devices,
            installations: None,
            dependencies: None,
            artifacts: None,
            logging: None,
            notifications: Arc::new(crate::mcp_notifications::CatalogNotifications::new(
                shutdown,
            )),
        }
    }
    fn plugin_service(&self) -> Result<&Arc<PluginService>> {
        self.plugins
            .as_ref()
            .ok_or_else(|| Error::Dependency("插件管理服务未配置".into()))
    }
    async fn invoke(&self, name: &str, input: Value) -> Result<Value> {
        if crate::interactive_mcp::manages(name) || self.app.session_definition(name).is_some() {
            return crate::interactive_mcp::invoke(&self.app, name, input).await;
        }
        match name {
            "deviceforge.list_services" | "deviceforge.call_service" => {
                crate::services::invoke(&self.app, name, input).await
            }
            "deviceforge.get_plugin_dependencies" => {
                let input: crate::plugin_dependencies::DependencyQuery = decode(input)?;
                encode(
                    self.dependencies
                        .as_ref()
                        .ok_or_else(|| Error::Dependency("插件依赖服务未配置".into()))?
                        .get(input.target)
                        .await?,
                )
            }
            "deviceforge.list_plugin_installations" => {
                if input != json!({}) {
                    return Err(Error::Invalid("此工具不接收参数".into()));
                }
                encode(
                    self.installations
                        .as_ref()
                        .ok_or_else(|| Error::Dependency("安装服务未配置".into()))?
                        .list()
                        .await?,
                )
            }
            "deviceforge.plan_plugin_installation" => {
                let source = decode(input)?;
                encode(
                    self.installations
                        .as_ref()
                        .ok_or_else(|| Error::Dependency("安装服务未配置".into()))?
                        .plan(source)
                        .await?,
                )
            }
            crate::plugin_guide::TOOL_NAME => crate::plugin_guide::get(input),
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
            "deviceforge.plugin_recovery_status" => {
                let input: PluginInput = decode(input)?;
                encode(self.app.plugin_recovery_view(&input.id)?)
            }
            "deviceforge.recover_plugin" => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    id: String,
                    generation: String,
                    input: Value,
                }
                let input: Input = decode(input)?;
                encode(
                    self.app
                        .recover_plugin(
                            input.id,
                            apk_domain::plugin_recovery::RecoveryInput {
                                generation: input.generation,
                                input: input.input,
                            },
                        )
                        .await?,
                )
            }
            operation => encode(self.app.submit_async(operation.into(), input).await?),
        }
    }
}
impl ServerHandler for McpAdapter {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new(
            "deviceforge",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(crate::plugin_guide::INSTRUCTIONS)
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(requested.supported_by(&self.get_info().capabilities))
    }
    async fn listen(&self, context: SubscriptionContext) -> std::result::Result<(), ErrorData> {
        self.notifications.listen(&self.app, context).await
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        let (revision, mut tools) = crate::mcp_tools::catalog(&self.app, self.plugins.is_some());
        tools.extend(crate::services::tools());
        tools.extend(crate::debugger::tools());
        if self.installations.is_some() {
            tools.extend(crate::plugin_installation_mcp::tools());
        }
        if self.dependencies.is_some() {
            tools.extend(crate::mcp_tools::dependency_tools());
        }
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
                self.app
                    .session_definition(name)
                    .map(crate::interactive_mcp::session_tool)
            })
            .or_else(|| {
                crate::mcp_tools::management_tools(self.plugins.is_some())
                    .into_iter()
                    .chain(crate::device_mcp::tools())
                    .chain(crate::services::tools())
                    .chain(crate::debugger::tools())
                    .chain(crate::interactive_mcp::tools())
                    .chain(
                        self.dependencies
                            .is_some()
                            .then(crate::mcp_tools::dependency_tools)
                            .into_iter()
                            .flatten(),
                    )
                    .chain(
                        self.installations
                            .is_some()
                            .then(crate::plugin_installation_mcp::tools)
                            .into_iter()
                            .flatten(),
                    )
                    .find(|tool| tool.name == name)
            })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let input = Value::Object(request.arguments.unwrap_or_default());
        let diagnostics = self
            .logging
            .as_ref()
            .map(|logging| crate::debugger::PersistentDiagnostics(logging.clone()));
        let called = if crate::debugger::manages(&request.name) {
            match context.extensions.get::<axum::http::request::Parts>() {
                Some(parts) => match crate::debugger::check(parts) {
                    Ok(()) => {
                        crate::debugger::invoke_configured(
                            &self.app,
                            self.plugins.as_ref(),
                            &self.debugger,
                            self.installations.as_ref(),
                            self.artifacts.as_deref(),
                            diagnostics.as_ref().map(|diagnostics| {
                                diagnostics as &dyn crate::debugger::DebuggerDiagnostics
                            }),
                            &request.name,
                            input,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                },
                None => Err(crate::ApiError::new(
                    axum::http::StatusCode::FORBIDDEN,
                    "debugger_connection_unknown",
                    "无法核实当前 MCP 的本机连接，请通过本机 HTTP MCP 地址连接后重试",
                )),
            }
        } else {
            self.invoke(&request.name, input)
                .await
                .map_err(crate::ApiError::from)
        };
        let result = match called {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => {
                let api_error = error;
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
    service_with_installations(app, plugins, devices, None, config)
}
pub(crate) fn service_with_installations(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    service_with_dependencies(app, plugins, devices, installations, None, config)
}

pub(crate) fn service_with_dependencies(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    dependencies: Option<Arc<apk_application::plugin_dependencies::DependencyService>>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    service_with_debugger(
        app,
        plugins,
        devices,
        installations,
        dependencies,
        Arc::new(apk_application::debugger::DebuggerService::default()),
        config,
    )
}

pub(crate) fn service_with_debugger(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    dependencies: Option<Arc<apk_application::plugin_dependencies::DependencyService>>,
    debugger: Arc<apk_application::debugger::DebuggerService>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    service_with_debugger_resources(
        app,
        plugins,
        devices,
        installations,
        dependencies,
        debugger,
        None,
        None,
        config,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn service_with_debugger_resources(
    app: Arc<Application>,
    plugins: Option<Arc<PluginService>>,
    devices: Arc<apk_application::devices::DeviceService>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    dependencies: Option<Arc<apk_application::plugin_dependencies::DependencyService>>,
    debugger: Arc<apk_application::debugger::DebuggerService>,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    logging: Option<deviceforge_observability::LogMetrics>,
    config: StreamableHttpServerConfig,
) -> StreamableHttpService<impl ServerHandler, LocalSessionManager> {
    let mut adapter = McpAdapter::new(app, plugins, devices, config.cancellation_token.clone());
    adapter.debugger = debugger;
    adapter.installations = installations;
    adapter.dependencies = dependencies;
    adapter.artifacts = artifacts;
    adapter.logging = logging;
    let handler = crate::mcp_observability::Observed(adapter);
    StreamableHttpService::new(
        move || Ok(handler.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    )
}
pub fn default_config() -> StreamableHttpServerConfig {
    // 个人及可信局域网与 HTTP 共用开放默认；部署者仍可显式设置 Host/Origin 清单。
    let mut config = StreamableHttpServerConfig::default().disable_allowed_hosts();
    config.legacy_session_mode = false;
    config.json_response = true;
    config.max_request_body_bytes = 256 * 1024;
    config
}
