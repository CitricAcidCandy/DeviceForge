use crate::{ApiError, ApiState};
use apk_application::plugin_lifecycle::PluginService;
use apk_domain::plugins::PluginInfo;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use std::sync::Arc;

fn service(state: &ApiState) -> Result<Arc<PluginService>, ApiError> {
    state
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.plugins.clone())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "not_configured",
                "插件管理服务未配置",
            )
        })
}
pub(crate) async fn list(State(state): State<ApiState>) -> Result<Json<Vec<PluginInfo>>, ApiError> {
    Ok(Json(service(&state)?.list()))
}
pub(crate) async fn load(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<PluginInfo>, ApiError> {
    Ok(Json(service(&state)?.load(id).await?))
}
pub(crate) async fn unload(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<PluginInfo>, ApiError> {
    Ok(Json(service(&state)?.unload(id).await?))
}
