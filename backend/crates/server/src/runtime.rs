use crate::{ApiError, ApiState};
use apk_application::plugin_lifecycle::PluginService;
use axum::{Json, extract::State, http::StatusCode};
use deviceforge_observability::{LogMetrics, LogStats};
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
pub(crate) async fn shutdown(State(state): State<ApiState>) -> Result<Json<Value>, ApiError> {
    tracing::info!("收到服务停止请求");
    runtime(&state)?.shutdown.cancel();
    Ok(Json(json!({"stopping":true})))
}
