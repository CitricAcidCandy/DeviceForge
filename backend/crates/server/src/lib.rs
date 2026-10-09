use apk_application::Application;
use apk_domain::{Error, Job, JobEvent, Operation};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, Request, State,
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
    gate: Arc<Gate>,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    runtime: Option<runtime::RuntimeServices>,
}
struct Gate {
    token: String,
    window: Mutex<(Instant, u32)>,
    limit: u32,
    inflight: Arc<tokio::sync::Semaphore>,
}
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
    build_router(app, token, requests_per_second, config, None, None)
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
    )
}
fn build_router(
    app: Arc<Application>,
    token: String,
    requests_per_second: u32,
    config: mcp::StreamableHttpServerConfig,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    runtime: Option<runtime::RuntimeServices>,
) -> apk_domain::Result<Router> {
    let plugin_service = runtime
        .as_ref()
        .and_then(|services| services.plugins.clone());
    let mcp_service = mcp::service_with_plugins(app.clone(), plugin_service, config);
    if token.trim().is_empty() || token.chars().any(char::is_whitespace) || requests_per_second == 0
    {
        return Err(Error::Invalid(
            "API 令牌不得为空或含空白，限流值必须大于零".into(),
        ));
    }
    let state = ApiState {
        app,
        artifacts,
        runtime,
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
        .route("/artifacts/{id}", get(artifacts::metadata))
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
        .route("/api/v2/diagnostics/logging", get(runtime::logging))
        .route("/api/v2/system/shutdown", post(runtime::shutdown))
        .route("/api/v2/plugins", get(plugin_routes::list))
        .route("/api/v2/plugins/{id}/load", post(plugin_routes::load))
        .route("/api/v2/plugins/{id}/unload", post(plugin_routes::unload))
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
        .layer(middleware::from_fn(correlation::audit))
        .with_state(state))
}
async fn guard(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    if supplied != Some(state.gate.token.as_str()) {
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
mod openapi;

pub mod mcp;

pub fn openapi_document() -> Value {
    openapi::document()
}

mod artifacts;
mod correlation;
mod mcp_observability;
mod mcp_tools;
mod mcp_wire;
mod plugin_routes;
mod response_stream;
mod responses;
pub mod runtime;
