use crate::{ApiError, ApiState};
use apk_domain::{
    Error,
    artifacts::{ArchivePage, Artifact, ArtifactStore},
};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, Request, State, rejection::QueryRejection},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UploadQuery {
    filename: String,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct EntryQuery {
    offset: Option<usize>,
    limit: Option<usize>,
}
fn store(state: &ApiState) -> Result<Arc<dyn ArtifactStore>, ApiError> {
    state.artifacts.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "服务尚未配置产物存储",
        )
    })
}
pub(super) async fn upload(
    State(state): State<ApiState>,
    query: Result<Query<UploadQuery>, QueryRejection>,
    request: Request,
) -> Result<(StatusCode, Json<Artifact>), ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "上传需要 filename 参数",
        )
    })?;
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "产物上传必须使用 application/octet-stream",
        ));
    }
    let stream = request
        .into_body()
        .into_data_stream()
        .map(|chunk| chunk.map_err(|_| Error::Invalid("上传连接中断或请求数据无效".into())));
    Ok((
        StatusCode::CREATED,
        Json(store(&state)?.put(query.filename, Box::pin(stream)).await?),
    ))
}
pub(super) async fn metadata(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Artifact>, ApiError> {
    Ok(Json(store(&state)?.get(&id).await?))
}
pub(super) async fn delete(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Artifact>, ApiError> {
    Ok(Json(store(&state)?.delete(&id).await?))
}
pub(super) async fn download(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let (metadata, stream) = store(&state)?.download(&id).await?;
    let name = percent_encoding::utf8_percent_encode(
        &metadata.filename,
        percent_encoding::NON_ALPHANUMERIC,
    );
    let disposition = format!("attachment; filename*=UTF-8''{name}");
    let mut response = (
        [
            (header::CONTENT_TYPE, metadata.media_type),
            (header::CONTENT_LENGTH, metadata.size.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (header::CACHE_CONTROL, "private, no-store".into()),
        ],
        Body::from_stream(stream),
    )
        .into_response();
    response
        .extensions_mut()
        .insert(crate::responses::RawRepresentation);
    Ok(response)
}
pub(super) async fn entries(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    query: Result<Query<EntryQuery>, QueryRejection>,
) -> Result<Json<ArchivePage>, ApiError> {
    let Query(query) = query
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", "条目查询参数无效"))?;
    Ok(Json(
        store(&state)?
            .archive_entries(&id, query.offset.unwrap_or(0), query.limit.unwrap_or(50))
            .await?,
    ))
}
