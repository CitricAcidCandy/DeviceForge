use apk_application::Application;
use apk_domain::{Error, Job, JobEvent, Operation};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, MatchedPath, Path, Query, Request, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct ApiState {
    app: Arc<Application>,
    devices: Arc<apk_application::devices::DeviceService>,
    gate: Arc<Gate>,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    runtime: Option<runtime::RuntimeServices>,
    packages: Option<Arc<apk_application::plugin_packages::PackageService>>,
    configurations: Option<Arc<apk_application::plugin_configurations::PluginConfigurationService>>,
    browser_configurations:
        Option<Arc<apk_application::browser_configurations::BrowserConfigurationService>>,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    installation_artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
}
struct Gate {
    token: String,
    window: Mutex<(Instant, u32)>,
    limit: u32,
    inflight: Arc<tokio::sync::Semaphore>,
}
const BROWSER_ASSET_ROUTE: &str = "/api/v2/browser-plugins/{id}/assets/{*path}";
const BROWSER_RUN_ASSET_ROUTE: &str = "/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{*path}";
const INSTALLATION_ASSET_ROUTE: &str =
    "/api/v2/plugin-installations/browser/{id}/revisions/{revision}/assets/{*path}";
#[derive(Serialize, schemars::JsonSchema)]
pub struct Failure {
    code: String,
    message: String,
}
struct ApiError(StatusCode, Failure);
impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self(
            status,
            Failure {
                code: code.into(),
                message: message.into(),
            },
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::warn!(code = %self.1.code, status = self.0.as_u16(), "请求处理失败");
        (self.0, Json(self.1)).into_response()
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let (status, code) = match &error {
            Error::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
            Error::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Error::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Error::Cancelled => (StatusCode::CONFLICT, "cancelled"),
            Error::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
            Error::CleanupFailed => (StatusCode::CONFLICT, "cleanup_failed"),
            Error::Dependency(_) => (StatusCode::BAD_GATEWAY, "dependency_failed"),
            Error::Storage(_) => (StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"),
        };
        if status.is_server_error() {
            // 底层错误可能包含部署路径，仅向客户端返回类别。
            Self::new(status, code, "服务依赖或存储异常")
        } else {
            Self::new(status, code, error.to_string())
        }
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Submit {
    pub operation: String,
    pub input: Value,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    limit: Option<usize>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct EventQuery {
    after: Option<u64>,
}

pub fn router(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
) -> apk_domain::Result<Router> {
    router_with_mcp(app, token, requests_per_second, mcp::default_config())
}
pub fn router_with_mcp(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
}
pub fn router_with_artifacts(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        None,
        None,
        None,
        None,
        None,
        None,
    )
}
pub fn router_with_runtime(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
    runtime: runtime::RuntimeServices,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        Some(runtime),
        None,
        None,
        None,
        None,
        None,
    )
}
pub fn router_with_packages(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
    runtime: runtime::RuntimeServices,
    packages: Arc<apk_application::plugin_packages::PackageService>,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        Some(runtime),
        Some(packages),
        None,
        None,
        None,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
pub fn router_with_configurations(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
    runtime: runtime::RuntimeServices,
    packages: Arc<apk_application::plugin_packages::PackageService>,
    configurations: Arc<apk_application::plugin_configurations::PluginConfigurationService>,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        Some(runtime),
        Some(packages),
        Some(configurations),
        None,
        None,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
pub fn router_with_browser_configurations(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
    runtime: runtime::RuntimeServices,
    packages: Arc<apk_application::plugin_packages::PackageService>,
    configurations: Arc<apk_application::plugin_configurations::PluginConfigurationService>,
    browser_configurations: Arc<
        apk_application::browser_configurations::BrowserConfigurationService,
    >,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        Some(runtime),
        Some(packages),
        Some(configurations),
        Some(browser_configurations),
        None,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
pub fn router_with_installations(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
    runtime: runtime::RuntimeServices,
    packages: Arc<apk_application::plugin_packages::PackageService>,
    configurations: Arc<apk_application::plugin_configurations::PluginConfigurationService>,
    browser_configurations: Arc<
        apk_application::browser_configurations::BrowserConfigurationService,
    >,
    installations: Arc<apk_application::plugin_installations::InstallationService>,
    installation_artifacts: Arc<dyn apk_domain::artifacts::ArtifactStore>,
) -> apk_domain::Result<Router> {
    build_router(
        app,
        token,
        requests_per_second,
        config,
        Some(artifacts),
        Some(runtime),
        Some(packages),
        Some(configurations),
        Some(browser_configurations),
        Some(installations),
        Some(installation_artifacts),
    )
}
#[allow(clippy::too_many_arguments)]
fn build_router(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    runtime: Option<runtime::RuntimeServices>,
    packages: Option<Arc<apk_application::plugin_packages::PackageService>>,
    configurations: Option<Arc<apk_application::plugin_configurations::PluginConfigurationService>>,
    browser_configurations: Option<
        Arc<apk_application::browser_configurations::BrowserConfigurationService>,
    >,
    installations: Option<Arc<apk_application::plugin_installations::InstallationService>>,
    installation_artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
) -> apk_domain::Result<Router> {
    let plugin_service = runtime
        .as_ref()
        .and_then(|services| services.plugins.clone());
    let devices = apk_application::devices::DeviceService::new(app.clone());
    let mcp_service = mcp::service_with_installations(
        app.clone(),
        plugin_service,
        devices.clone(),
        installations.clone(),
        config,
    );
    if token.chars().any(char::is_whitespace) || requests_per_second == 0 {
        return Err(Error::Invalid(
            "可选 API 令牌不得含空白，限流值必须大于零".into(),
        ));
    }
    let state = ApiState {
        devices,
        app,
        artifacts,
        runtime,
        packages,
        configurations,
        browser_configurations,
        installations,
        installation_artifacts,
        gate: Arc::new(Gate {
            token,
            window: Mutex::new((Instant::now(), 0)),
            limit: requests_per_second,
            inflight: Arc::new(tokio::sync::Semaphore::new(128)),
        }),
    };
    let api = Router::new()
        .route(
            "/artifacts",
            post(artifacts::upload).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/artifacts/{id}",
            get(artifacts::metadata).delete(artifacts::delete),
        )
        .route("/artifacts/{id}/content", get(artifacts::download))
        .route("/artifacts/{id}/entries", get(artifacts::entries))
        .route("/health", get(health))
        .route("/operations", get(operations))
        .route("/jobs", get(jobs).post(submit))
        .route("/jobs/{id}", get(job))
        .route("/jobs/{id}/cancel", post(cancel))
        .route("/jobs/{id}/events", get(events))
        .route("/openapi.json", get(openapi));
    Ok(Router::new()
        .nest("/api/v1", api.clone())
        .nest("/api/v2", api)
        .merge(interactive_routes::router())
        .route("/api/v2/diagnostics/logging", get(runtime::logging))
        .route("/api/v2/system/shutdown", post(runtime::shutdown))
        .route("/api/v2/plugins", get(plugin_routes::list))
        .route(
            "/api/v2/plugin-installations",
            get(plugin_installations::list).post(plugin_installations::install),
        )
        .route(
            "/api/v2/plugin-installations/plan",
            post(plugin_installations::plan),
        )
        .route(
            "/api/v2/plugin-installations/cleanup",
            post(plugin_installations::cleanup),
        )
        .route(
            "/api/v2/plugin-installations/artifacts",
            post(plugin_installations::upload).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/v2/plugin-installations/{id}",
            get(plugin_installations::get)
                .put(plugin_installations::update)
                .delete(plugin_installations::delete),
        )
        .route(
            "/api/v2/plugin-installations/{id}/enabled",
            axum::routing::patch(plugin_installations::enabled),
        )
        .route(INSTALLATION_ASSET_ROUTE, get(plugin_installations::asset))
        .route(
            "/api/v2/browser-plugin-configurations/{id}",
            get(browser_configuration_routes::get).patch(browser_configuration_routes::patch),
        )
        .route(
            "/api/v2/plugin-configurations",
            get(plugin_configuration_routes::list),
        )
        .route(
            "/api/v2/plugin-configurations/{kind}/{id}",
            get(plugin_configuration_routes::get).patch(plugin_configuration_routes::patch),
        )
        .route(
            "/api/v2/plugin-configurations/{kind}/{id}/reset",
            post(plugin_configuration_routes::reset),
        )
        .route(
            "/api/v2/plugin-configurations/{kind}/{id}/apply",
            post(plugin_configuration_routes::apply),
        )
        .route("/api/v2/device-providers", get(device_routes::providers))
        .route("/api/v2/devices", get(device_routes::directories))
        .route(
            "/api/v2/device-providers/{id}/refresh",
            post(device_routes::refresh),
        )
        .route("/api/v2/device-actions", post(device_routes::invoke))
        .route("/api/v2/plugins/{id}/load", post(plugin_routes::load))
        .route("/api/v2/plugins/{id}/unload", post(plugin_routes::unload))
        .route(
            "/api/v2/plugins/{id}/recovery",
            get(plugin_recovery::get).post(plugin_recovery::recover),
        )
        .route(
            "/api/v2/plugin-packages/{kind}",
            get(plugin_package_routes::list)
                .post(plugin_package_routes::install)
                .layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/v2/plugin-packages/{kind}/{id}",
            axum::routing::delete(plugin_package_routes::delete)
                .put(plugin_package_routes::update)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(BROWSER_ASSET_ROUTE, get(plugin_package_routes::asset))
        .route(
            BROWSER_RUN_ASSET_ROUTE,
            get(plugin_package_routes::run_asset),
        )
        .route_service("/mcp", mcp_service)
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "接口不存在") })
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "接口不支持此方法",
            )
        })
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn(cors::allow_browser))
        .layer(middleware::from_fn(correlation::audit))
        .with_state(state))
}
async fn guard(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    // 已发布的模块和相对静态资源不携带令牌，便于浏览器原生模块加载。
    let public_asset = (request.method() == axum::http::Method::GET
        || request.method() == axum::http::Method::HEAD)
        && request
            .extensions()
            .get::<MatchedPath>()
            .is_some_and(|path| {
                [
                    BROWSER_ASSET_ROUTE,
                    BROWSER_RUN_ASSET_ROUTE,
                    INSTALLATION_ASSET_ROUTE,
                ]
                .contains(&path.as_str())
            });
    if !state.gate.token.is_empty() && !public_asset && supplied != Some(state.gate.token.as_str())
    {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "需要有效的访问令牌",
        )
        .into_response();
    }
    let allowed = match state.gate.window.lock() {
        Ok(mut window) => {
            if window.0.elapsed() >= Duration::from_secs(1) {
                *window = (Instant::now(), 0);
            }
            if window.1 >= state.gate.limit {
                false
            } else {
                window.1 += 1;
                true
            }
        }
        Err(_) => {
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "服务限流状态异常",
            )
            .into_response();
        }
    };
    if !allowed {
        return ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "请求过于频繁，请稍后重试",
        )
        .into_response();
    }
    let Ok(permit) = state.gate.inflight.clone().try_acquire_owned() else {
        return ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "concurrency_limited",
            "并发请求已达到上限",
        )
        .into_response();
    };
    if let Some(header) = request.headers().get("x-deviceforge-plugin-release") {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Revision {
            id: String,
            revision: String,
        }
        let parsed = header
            .to_str()
            .ok()
            .and_then(|value| serde_json::from_str::<Revision>(value).ok());
        let check = async {
            let input = parsed.ok_or_else(|| Error::Invalid("浏览器插件发布修订头无效".into()))?;
            let service = state
                .installations
                .as_ref()
                .ok_or_else(|| Error::Conflict("完整发布服务未配置".into()))?;
            let record = service.get(&input.id).await?;
            if !record.enabled || record.revision != input.revision {
                return Err(Error::Conflict(
                    "浏览器插件发布已切换，请同步插件后重试".into(),
                ));
            }
            Ok::<_, Error>(())
        }
        .await;
        if let Err(error) = check {
            return ApiError::from(error).into_response();
        }
    }
    let mut response = next.run(request).await;
    response
        .extensions_mut()
        .insert(response_stream::RequestPermit {
            _permit: Arc::new(permit),
        });
    response
}
async fn operations(State(state): State<ApiState>) -> Json<Vec<Operation>> {
    Json(state.app.operations())
}
async fn submit(
    State(state): State<ApiState>,
    payload: Result<Json<Submit>, JsonRejection>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    let Json(payload) = payload.map_err(|e| {
        ApiError::new(
            if e.status() == StatusCode::UNPROCESSABLE_ENTITY {
                StatusCode::BAD_REQUEST
            } else {
                e.status()
            },
            "invalid_input",
            "请求必须为符合协议的 JSON，且不超过 256 KiB",
        )
    })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async(payload.operation, payload.input)
                .await?,
        ),
    ))
}
async fn jobs(
    State(state): State<ApiState>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Vec<Job>>, ApiError> {
    let Query(query) = query
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", "列表查询参数无效"))?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "limit 必须在 1 到 200 之间",
        ));
    }
    Ok(Json(state.app.list_async(limit).await?))
}
async fn job(State(state): State<ApiState>, Path(id): Path<String>) -> Result<Json<Job>, ApiError> {
    Ok(Json(state.app.get_async(id).await?))
}
async fn cancel(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Job>, ApiError> {
    Ok(Json(state.app.cancel_async(id).await?))
}
async fn events(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    query: Result<Query<EventQuery>, QueryRejection>,
) -> Result<Json<Vec<JobEvent>>, ApiError> {
    let Query(query) = query
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", "事件游标无效"))?;
    Ok(Json(
        state.app.events_async(id, query.after.unwrap_or(0)).await?,
    ))
}
async fn health(axum::extract::OriginalUri(uri): axum::extract::OriginalUri) -> Json<Value> {
    let version = if uri.path().contains("/v2/") { 2 } else { 1 };
    Json(json!({"status":"ok","api_version":version}))
}
async fn openapi(request: Request) -> Response {
    let mut value = crate::openapi::document();
    if let Some(correlation) = request.extensions().get::<correlation::Correlation>() {
        value["x-deviceforge-log-id"] = json!(correlation.context.log_id);
    }
    let mut response = Json(value).into_response();
    response
        .extensions_mut()
        .insert(responses::RawRepresentation);
    response
}
mod interactive;
mod interactive_mcp;
mod interactive_openapi;
mod interactive_routes;
mod openapi;

pub mod mcp;

pub fn openapi_document() -> Value {
    openapi::document()
}

mod artifacts;
mod browser_configuration_openapi;
mod browser_configuration_routes;
pub mod client_connection;
mod correlation;
mod cors;
mod device_mcp;
mod device_routes;
mod mcp_notifications;
mod mcp_observability;
mod mcp_tools;
mod mcp_wire;
mod plugin_configuration_openapi;
mod plugin_configuration_routes;
mod plugin_guide;
mod plugin_installation_mcp;
mod plugin_installation_openapi;
pub mod plugin_installations;
mod plugin_package_routes;
mod plugin_recovery;
mod plugin_routes;
mod response_stream;
mod responses;
pub mod runtime;
