use crate::{ApiError, ApiState};
use apk_application::plugin_lifecycle::PluginService;
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
};
use deviceforge_observability::{LogMetrics, LogOrder, LogSearch, LogStats};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct RuntimeServices {
    pub logging: LogMetrics,
    pub shutdown: CancellationToken,
    pub plugins: Option<Arc<PluginService>>,
}
fn runtime(state: &ApiState) -> Result<&RuntimeServices, ApiError> {
    state.runtime.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "运行诊断服务未配置",
        )
    })
}
pub(crate) async fn logging(State(state): State<ApiState>) -> Result<Json<LogStats>, ApiError> {
    Ok(Json(runtime(&state)?.logging.snapshot()))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LogQuery {
    log_id: Option<String>,
    q: Option<String>,
    #[serde(default)]
    order: LogOrder,
}

pub(crate) async fn logs(
    State(state): State<ApiState>,
    query: Result<Query<LogQuery>, QueryRejection>,
) -> Result<Json<LogSearch>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "请填写日志 ID 或搜索词，排序只能选择 asc 或 desc",
        )
    })?;
    let found = runtime(&state)?
        .logging
        .search_logs(query.log_id.as_deref(), query.q.as_deref(), query.order)
        .await
        .map_err(|error| {
            let (status, code, message) = match error.kind() {
                std::io::ErrorKind::InvalidInput => (
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    "请填写完整日志 ID 或 1 至 128 字节的搜索词，二者只能填一项",
                ),
                std::io::ErrorKind::WouldBlock => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "busy",
                    "日志查询较多，请稍后重试",
                ),
                std::io::ErrorKind::TimedOut => (
                    StatusCode::GATEWAY_TIMEOUT,
                    "timeout",
                    "日志查询等待时间已用完，请稍后重试",
                ),
                _ => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "log_read_failed",
                    "无法读取保留日志，请检查日志存储是否可用",
                ),
            };
            ApiError::new(status, code, message)
        })?;
    Ok(Json(found))
}
pub(crate) async fn shutdown(State(state): State<ApiState>) -> Result<Json<Value>, ApiError> {
    tracing::info!("收到服务停止请求");
    runtime(&state)?.shutdown.cancel();
    Ok(Json(json!({"stopping":true})))
}

#[cfg(test)]
mod tests;
