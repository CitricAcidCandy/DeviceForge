//! 恢复HTTP边界只映射公开请求，核对和互斥由应用统一执行。
use crate::{ApiError, ApiState};
use apk_domain::{
    Error,
    plugin_recovery::{RecoveryInput, RecoveryView},
};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
};

pub(crate) async fn get(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<RecoveryView>, ApiError> {
    Ok(Json(state.app.plugin_recovery_view(&id)?))
}
pub(crate) async fn recover(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: Result<Json<RecoveryInput>, JsonRejection>,
) -> Result<Json<RecoveryView>, ApiError> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("恢复请求须包含generation和对象input".into()))?;
    Ok(Json(state.app.recover_plugin(id, input).await?))
}
