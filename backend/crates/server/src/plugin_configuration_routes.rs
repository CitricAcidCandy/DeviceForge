//! 插件配置的薄 HTTP 适配；校验、CAS 和生命周期由配置用例服务统一负责。
use crate::{ApiError, ApiState};
use apk_application::plugin_configurations::PluginConfigurationService;
use apk_domain::{Error, plugin_configurations::*};
use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
};
use serde::Deserialize;
use std::sync::Arc;

fn service(state: &ApiState) -> Result<Arc<PluginConfigurationService>, ApiError> {
    state.configurations.clone().ok_or_else(|| {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "统一插件配置服务未配置",
        )
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListQuery {
    kind: String,
}
fn target(path: Result<Path<(String, String)>, PathRejection>) -> Result<String, ApiError> {
    let Path((kind, id)) = path.map_err(|_| Error::Invalid("配置种类或插件 ID 无效".into()))?;
    if kind != "server" {
        return Err(Error::Invalid("当前统一配置只支持 server 插件".into()).into());
    }
    Ok(id)
}
pub(crate) async fn list(
    State(state): State<ApiState>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Vec<PluginConfiguration>>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("配置目录必须指定 kind=server".into()))?;
    if query.kind != "server" {
        return Err(Error::Invalid("当前统一配置只支持 server 插件".into()).into());
    }
    Ok(Json(service(&state)?.list().await?))
}
pub(crate) async fn get(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<Json<PluginConfiguration>, ApiError> {
    Ok(Json(service(&state)?.get(&target(path)?).await?))
}
pub(crate) async fn patch(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
    input: Result<Json<ConfigurationPatch>, JsonRejection>,
) -> Result<Json<PluginConfiguration>, ApiError> {
    let id = target(path)?;
    let Json(input) = input
        .map_err(|_| Error::Invalid("配置保存须提供 expected_revision 和对象 patch".into()))?;
    Ok(Json(
        service(&state)?
            .patch(&id, input.expected_revision, input.patch)
            .await?,
    ))
}
pub(crate) async fn reset(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
    input: Result<Json<ConfigurationRevision>, JsonRejection>,
) -> Result<Json<PluginConfiguration>, ApiError> {
    let id = target(path)?;
    let Json(input) =
        input.map_err(|_| Error::Invalid("恢复默认须提供 expected_revision".into()))?;
    Ok(Json(
        service(&state)?.reset(&id, input.expected_revision).await?,
    ))
}
pub(crate) async fn apply(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
    input: Result<Json<ConfigurationRevision>, JsonRejection>,
) -> Result<Json<PluginConfiguration>, ApiError> {
    let id = target(path)?;
    let Json(input) =
        input.map_err(|_| Error::Invalid("应用配置须提供 expected_revision".into()))?;
    Ok(Json(
        service(&state)?.apply(&id, input.expected_revision).await?,
    ))
}
