//! 浏览器配置的薄 HTTP 适配，原值供公开浏览器 SDK 使用，界面自行遮蔽。
use crate::{ApiError, ApiState};
use apk_application::browser_configurations::BrowserConfigurationService;
use apk_domain::{Error, browser_configurations::*};
use axum::{
    Json,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::StatusCode,
};
use std::sync::Arc;

fn service(state: &ApiState) -> Result<Arc<BrowserConfigurationService>, ApiError> {
    state.browser_configurations.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "浏览器插件配置服务未配置",
        )
    })
}

fn target(path: Result<Path<String>, PathRejection>) -> Result<String, ApiError> {
    let Path(id) = path.map_err(|_| Error::Invalid("浏览器配置插件 ID 无效".into()))?;
    Ok(id)
}

pub(crate) async fn get(
    State(state): State<ApiState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<BrowserConfigurationView>, ApiError> {
    Ok(Json(service(&state)?.get(&target(path)?).await?))
}

pub(crate) async fn patch(
    State(state): State<ApiState>,
    path: Result<Path<String>, PathRejection>,
    input: Result<Json<BrowserConfigurationPatch>, JsonRejection>,
) -> Result<Json<BrowserConfigurationView>, ApiError> {
    let id = target(path)?;
    let Json(input) = input.map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::from(Error::TooLarge)
        } else {
            ApiError::from(Error::Invalid(
                "浏览器配置保存须提供 expected_revision 和完整 record".into(),
            ))
        }
    })?;
    Ok(Json(
        service(&state)?
            .patch(&id, input.expected_revision, input.record)
            .await?,
    ))
}

#[cfg(test)]
mod tests;
