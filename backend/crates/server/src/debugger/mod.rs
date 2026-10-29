//! 调试 HTTP 与 MCP 共用适配；连接校验不改变普通业务的局域网行为。
mod access;
mod integration;
pub(crate) mod openapi;
mod server_target;
mod tools;

use crate::{ApiError, ApiState};
use apk_application::debugger::{
    BridgeAck, BridgeBatch, BridgeHeartbeat, BridgePoll, BridgeRegistration, BridgeStatus,
    BrowserInstance, DebugCommandReceipt, DebuggerError, ErrorCode,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
pub(crate) use integration::invoke as invoke_configured;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub(crate) use tools::{DebuggerDiagnostics, PersistentDiagnostics, manages, tools};

pub(crate) fn check(parts: &axum::http::request::Parts) -> Result<(), ApiError> {
    access::check(parts)
}

pub(crate) fn error(error: DebuggerError) -> ApiError {
    use axum::http::StatusCode;
    let (status, code) = match error.code {
        ErrorCode::InvalidInput => (StatusCode::BAD_REQUEST, "debugger_invalid_input"),
        ErrorCode::NotFound => (StatusCode::NOT_FOUND, "debugger_not_found"),
        ErrorCode::Capacity => (StatusCode::TOO_MANY_REQUESTS, "debugger_capacity"),
        ErrorCode::Busy => (StatusCode::TOO_MANY_REQUESTS, "debugger_busy"),
        ErrorCode::InactiveSession => (StatusCode::CONFLICT, "debugger_session_inactive"),
        ErrorCode::StaleTarget => (StatusCode::CONFLICT, "debugger_target_changed"),
        ErrorCode::WrongInstance => (StatusCode::CONFLICT, "debugger_wrong_instance"),
        ErrorCode::DuplicateReceipt => (StatusCode::CONFLICT, "debugger_duplicate_receipt"),
        ErrorCode::NotDelivered => (StatusCode::CONFLICT, "debugger_not_delivered"),
        ErrorCode::ExpiredCommand => (StatusCode::CONFLICT, "debugger_receipt_expired"),
        ErrorCode::UnsupportedTarget => (StatusCode::BAD_REQUEST, "debugger_target_unsupported"),
        ErrorCode::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "debugger_unavailable"),
    };
    ApiError::new(status, code, error.message)
}

async fn local_only(request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    if let Err(error) = check(&parts) {
        return error.into_response();
    }
    next.run(Request::from_parts(parts, body)).await
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolCall {
    name: String,
    input: Value,
}

pub(crate) fn router() -> Router<ApiState> {
    Router::new()
        .route("/api/v2/debugger/capabilities", get(capabilities))
        .route("/api/v2/debugger/call", post(call))
        .route("/api/v2/debugger/bridge/register", post(register))
        .route("/api/v2/debugger/bridge/heartbeat", post(heartbeat))
        .route("/api/v2/debugger/bridge/poll", post(poll))
        .route(
            "/api/v2/debugger/bridge/ack",
            post(acknowledge).layer(DefaultBodyLimit::max(1024 * 1024 + 4096)),
        )
        .route("/api/v2/debugger/bridge/disconnect", post(disconnect))
        .route_layer(middleware::from_fn(local_only))
}

async fn capabilities(State(state): State<ApiState>) -> Json<Value> {
    Json(json!({"protocol_version":1,"local_only":true,
        "stage":"integration","tools":tools().into_iter().map(|tool| tool.name).collect::<Vec<_>>(),
        "source_breakpoints":false,"arbitrary_evaluation":false,
        "reload_timeout_ms":30000,"automation_timeout_ms":30000,"automation_max_steps":32,
        "data_value_max_bytes":262144,"persistent_log_pagination":state.runtime.is_some(),
        "target_activity_read_only":true,"activity_max_page":50,"automation_step_label_max_chars":80,
        "report_export":state.artifacts.is_some(),
        "ui_requires_selected_browser":true,"production_acceptance_complete":false}))
}

fn body<T>(body: std::result::Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(value)| value).map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "调试请求的字段或类型不符合契约，请查询当前宿主的调试能力与输入模式",
        )
    })
}

async fn call(
    State(state): State<ApiState>,
    request: std::result::Result<Json<ToolCall>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let request = body(request)?;
    let diagnostics = state
        .runtime
        .as_ref()
        .map(|runtime| PersistentDiagnostics(runtime.logging.clone()));
    invoke_configured(
        &state.app,
        state
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.plugins.as_ref()),
        &state.debugger,
        state.installations.as_ref(),
        state.artifacts.as_deref(),
        diagnostics
            .as_ref()
            .map(|diagnostics| diagnostics as &dyn DebuggerDiagnostics),
        &request.name,
        request.input,
    )
    .await
    .map(Json)
}

async fn register(
    State(state): State<ApiState>,
    request: std::result::Result<Json<BridgeRegistration>, JsonRejection>,
) -> Result<Json<BrowserInstance>, ApiError> {
    state
        .debugger
        .register_instance(body(request)?)
        .map(Json)
        .map_err(error)
}

async fn heartbeat(
    State(state): State<ApiState>,
    request: std::result::Result<Json<BridgeHeartbeat>, JsonRejection>,
) -> Result<Json<BridgeStatus>, ApiError> {
    state
        .debugger
        .heartbeat(body(request)?)
        .map(Json)
        .map_err(error)
}

async fn poll(
    State(state): State<ApiState>,
    request: std::result::Result<Json<BridgePoll>, JsonRejection>,
) -> Result<Json<BridgeBatch>, ApiError> {
    state
        .debugger
        .poll(body(request)?)
        .await
        .map(Json)
        .map_err(error)
}

async fn acknowledge(
    State(state): State<ApiState>,
    request: std::result::Result<Json<BridgeAck>, JsonRejection>,
) -> Result<Json<DebugCommandReceipt>, ApiError> {
    state
        .debugger
        .acknowledge(body(request)?)
        .map(Json)
        .map_err(error)
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstanceRequest {
    instance_id: String,
}

async fn disconnect(
    State(state): State<ApiState>,
    request: std::result::Result<Json<InstanceRequest>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let request = body(request)?;
    state
        .debugger
        .disconnect(&request.instance_id)
        .map_err(error)?;
    Ok(Json(json!({"disconnected":true})))
}
