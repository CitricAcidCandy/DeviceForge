//! 统一安装的薄 HTTP 边界；所有写操作进入共享任务用例。
use crate::{ApiError, ApiState};
use apk_application::{
    installation_operations::{
        InstallationChange, InstallationDelete, InstallationRequest, InstallationUpdate,
    },
    plugin_installations::InstallationService,
};
use apk_domain::{Error, plugin_installations::*};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::sync::Arc;

pub(crate) async fn cleanup(
    State(state): State<ApiState>,
    body: Result<
        Json<apk_application::installation_operations::InstallationCleanup>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Result<impl IntoResponse, ApiError> {
    service(&state)?;
    let Json(input) = body.map_err(|_| Error::Invalid("资源清理请求 JSON 无效".into()))?;
    let input =
        serde_json::to_value(input).map_err(|_| Error::Invalid("资源清理请求编码失败".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async("installation.cleanup".into(), input)
                .await?,
        ),
    ))
}

fn service(state: &ApiState) -> Result<Arc<InstallationService>, ApiError> {
    state.installations.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "完整插件安装服务未配置",
        )
    })
}
pub(crate) async fn upload(
    State(state): State<ApiState>,
    axum::extract::Query(query): axum::extract::Query<std::collections::BTreeMap<String, String>>,
    request: axum::extract::Request,
) -> Result<impl IntoResponse, ApiError> {
    let filename = query
        .get("filename")
        .filter(|name| name.ends_with(".zip"))
        .ok_or_else(|| Error::Invalid("离线完整包需要 ZIP 文件名".into()))?
        .clone();
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "离线包上传使用 application/octet-stream",
        ));
    }
    let store = state
        .installation_artifacts
        .as_ref()
        .ok_or_else(|| Error::Dependency("安装产物存储未配置".into()))?;
    let stream = request
        .into_body()
        .into_data_stream()
        .map(|chunk| chunk.map_err(|_| Error::Invalid("离线包上传中断".into())));
    Ok((
        StatusCode::CREATED,
        Json(store.put(filename, Box::pin(stream)).await?),
    ))
}
pub(crate) async fn list(
    State(state): State<ApiState>,
) -> Result<Json<Vec<InstalledRelease>>, ApiError> {
    Ok(Json(service(&state)?.list().await?))
}
pub(crate) async fn get(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<InstalledRelease>, ApiError> {
    Ok(Json(service(&state)?.get(&id).await?))
}
pub(crate) async fn plan(
    State(state): State<ApiState>,
    body: Result<Json<InstallSource>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<InstallationPlan>, ApiError> {
    let Json(source) = body.map_err(|_| Error::Invalid("安装计划请求 JSON 无效".into()))?;
    Ok(Json(service(&state)?.plan(source).await?))
}
pub(crate) async fn install(
    State(state): State<ApiState>,
    body: Result<Json<InstallationRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    service(&state)?;
    let Json(input) = body.map_err(|_| Error::Invalid("安装请求 JSON 无效".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async(
                    "installation.install".into(),
                    serde_json::to_value(input)
                        .map_err(|_| Error::Invalid("安装请求编码失败".into()))?,
                )
                .await?,
        ),
    ))
}
pub(crate) async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: Result<Json<InstallationRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    service(&state)?;
    let Json(input) = body.map_err(|_| Error::Invalid("更新请求 JSON 无效".into()))?;
    let revision = input
        .expected_revision
        .ok_or_else(|| Error::Invalid("更新必须提供 expected_revision".into()))?;
    let input = serde_json::to_value(InstallationUpdate {
        id,
        source: input.source,
        expected_revision: revision,
    })
    .map_err(|_| Error::Invalid("更新请求编码失败".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async("installation.update".into(), input)
                .await?,
        ),
    ))
}
pub(crate) async fn enabled(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: Result<Json<InstallationEnabled>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    service(&state)?;
    let Json(input) = body.map_err(|_| Error::Invalid("启停请求 JSON 无效".into()))?;
    let input = serde_json::to_value(InstallationChange {
        id,
        expected_revision: input.expected_revision,
        enabled: input.enabled,
    })
    .map_err(|_| Error::Invalid("启停请求编码失败".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async("installation.enabled".into(), input)
                .await?,
        ),
    ))
}
pub(crate) async fn delete(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: Result<Json<InstallationRevision>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    service(&state)?;
    let Json(input) = body.map_err(|_| Error::Invalid("卸载请求 JSON 无效".into()))?;
    let input = serde_json::to_value(InstallationDelete {
        id,
        expected_revision: input.expected_revision,
    })
    .map_err(|_| Error::Invalid("卸载请求编码失败".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .app
                .submit_async("installation.uninstall".into(), input)
                .await?,
        ),
    ))
}
pub(crate) async fn asset(
    State(state): State<ApiState>,
    Path((id, revision, path)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let asset = service(&state)?.asset(&id, &revision, &path).await?;
    let mut response = Body::from_stream(asset.stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        asset
            .content_type
            .parse()
            .map_err(|_| Error::Storage("资源媒体类型无效".into()))?,
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        asset
            .size
            .to_string()
            .parse()
            .map_err(|_| Error::Storage("资源长度无效".into()))?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable"
            .parse()
            .expect("固定响应头有效"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        "nosniff".parse().expect("固定响应头有效"),
    );
    response
        .extensions_mut()
        .insert(crate::responses::RawRepresentation);
    Ok(response)
}
