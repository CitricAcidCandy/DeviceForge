//! 在线包的薄 HTTP 边界；部署规则与文件副作用由服务负责。
use crate::{ApiError, ApiState, responses::RawRepresentation};
use apk_application::plugin_packages::PackageService;
use apk_domain::{Error, plugin_packages::*};
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;

fn service(state: &ApiState) -> Result<Arc<PackageService>, ApiError> {
    state.packages.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "在线插件包服务未配置",
        )
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UploadQuery {
    format: PackageFormat,
}

pub(crate) async fn list(
    State(state): State<ApiState>,
    path: Result<Path<PackageKind>, PathRejection>,
) -> Result<Json<Vec<PackageInfo>>, ApiError> {
    let Path(kind) =
        path.map_err(|_| Error::Invalid("插件包 kind 必须为 server 或 browser".into()))?;
    Ok(Json(service(&state)?.list(kind).await?))
}
pub(crate) async fn install(
    State(state): State<ApiState>,
    path: Result<Path<PackageKind>, PathRejection>,
    query: Result<Query<UploadQuery>, QueryRejection>,
    headers: HeaderMap,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    let Path(kind) =
        path.map_err(|_| Error::Invalid("插件包 kind 必须为 server 或 browser".into()))?;
    let Query(query) =
        query.map_err(|_| Error::Invalid("查询仅接受必填 format=zip 或 tgz".into()))?;
    let media = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    let expected = match query.format {
        PackageFormat::Zip => "application/zip",
        PackageFormat::Tgz => "application/gzip",
    };
    if media != expected {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_media_type",
            "包媒体类型必须与 format 对应",
        ));
    }
    if headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > 64 * 1024 * 1024)
    {
        return Err(Error::TooLarge.into());
    }
    let stream = body
        .into_data_stream()
        .map(|value| value.map_err(|_| Error::Invalid("包上传传输失败".into())));
    Ok((
        StatusCode::CREATED,
        Json(
            service(&state)?
                .install(kind, query.format, Box::pin(stream))
                .await?,
        ),
    ))
}
pub(crate) async fn delete(
    State(state): State<ApiState>,
    path: Result<Path<(PackageKind, String)>, PathRejection>,
) -> Result<Json<PackageInfo>, ApiError> {
    let Path((kind, id)) = path.map_err(|_| Error::Invalid("包种类或 ID 路径无效".into()))?;
    Ok(Json(service(&state)?.delete(kind, id).await?))
}
async fn representation(state: ApiState, id: String, path: String) -> Result<Response, ApiError> {
    let asset = service(&state)?.asset(&id, &path).await?;
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
        "no-store".parse().expect("固定响应头有效"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        "nosniff".parse().expect("固定响应头有效"),
    );
    response.extensions_mut().insert(RawRepresentation);
    Ok(response)
}
pub(crate) async fn asset(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((id, path)) = path.map_err(|_| Error::Invalid("资产路径编码无效".into()))?;
    representation(state, id, path).await
}
pub(crate) async fn run_asset(
    State(state): State<ApiState>,
    path: Result<Path<(String, String, String)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((id, run_id, path)) =
        path.map_err(|_| Error::Invalid("运行资产路径编码无效".into()))?;
    if run_id.is_empty()
        || run_id.len() > 100
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(Error::Invalid(
            "浏览器运行 ID 必须是最多 100 字节的字母数字及下划线或连字符".into(),
        )
        .into());
    }
    representation(state, id, path).await
}
