use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    CatalogResult, MarketEntry, ResourceRecord, Store, capabilities::RESOURCE_MAX_BYTES,
    model::CatalogQuery, store::StoreError,
};

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    uploads: Arc<tokio::sync::Semaphore>,
}

pub fn router(store: Store) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/resources", post(upload_resource))
        .route(
            "/api/v1/resources/{sha256}",
            get(download_resource).head(download_resource),
        )
        .route("/api/v1/resources/{sha256}/meta", get(resource_metadata))
        .route("/api/v1/catalog", get(catalog).post(publish_catalog_entry))
        .route(
            "/api/v1/catalog/{id}/{version}",
            delete(delete_catalog_entry),
        )
        .layer(CorsLayer::permissive().expose_headers(Any))
        .with_state(AppState {
            store,
            uploads: Arc::new(tokio::sync::Semaphore::new(4)),
        })
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "service": "deviceforge-resource-server" }))
}

async fn capabilities() -> Json<serde_json::Value> {
    Json(crate::capabilities::document())
}

async fn upload_resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<ResourceRecord>), ApiError> {
    let _permit = state
        .uploads
        .try_acquire()
        .map_err(|_| ApiError::Conflict)?;
    let content_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if content_length.is_some_and(|size| size > RESOURCE_MAX_BYTES) {
        return Err(ApiError::PayloadTooLarge);
    }
    let mut filename =
        header_text(&headers, "x-resource-filename").unwrap_or_else(|| "resource.bin".to_owned());
    if header_text(&headers, "x-resource-filename-encoding").as_deref() == Some("percent") {
        filename = percent_encoding::percent_decode_str(&filename)
            .decode_utf8()
            .map_err(|_| ApiError::BadRequest("文件名编码无效".into()))?
            .into_owned();
    }
    let media_type = header_text(&headers, header::CONTENT_TYPE.as_str())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let kind = header_text(&headers, "x-resource-kind").unwrap_or_else(|| "resource".to_owned());
    let temporary = state.store.temp_path();
    let _cleanup = UploadCleanup(temporary.clone());
    let mut file = fs::File::create(&temporary).await?;
    let mut stream = body.into_data_stream();
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| ApiError::BadRequest(format!("上传数据无效：{error}")))?;
        size = size.saturating_add(chunk.len() as u64);
        if size > RESOURCE_MAX_BYTES {
            let _ = fs::remove_file(&temporary).await;
            return Err(ApiError::PayloadTooLarge);
        }
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let sha256 = format!("{:x}", digest.finalize());
    let store = state.store.clone();
    let temporary_for_publish = temporary.clone();
    let record = tokio::task::spawn_blocking(move || {
        store.publish_blob(
            &temporary_for_publish,
            &filename,
            &media_type,
            &kind,
            size,
            &sha256,
        )
    })
    .await??;
    Ok((StatusCode::CREATED, Json(record)))
}

struct UploadCleanup(std::path::PathBuf);
impl Drop for UploadCleanup {
    fn drop(&mut self) {
        let path = self.0.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = fs::remove_file(path).await;
            });
        }
    }
}

async fn resource_metadata(
    State(state): State<AppState>,
    Path(sha256): Path<String>,
) -> Result<Json<ResourceRecord>, ApiError> {
    let record = load_resource(state.store, sha256).await?;
    Ok(Json(record))
}

async fn download_resource(
    State(state): State<AppState>,
    method: Method,
    Path(sha256): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let record = load_resource(state.store.clone(), sha256).await?;
    let path = state.store.resource_path(&record)?;
    // HEAD 和条件请求也核对真实文件，不能只凭数据库宣称资源完整可用。
    let mut file = fs::File::open(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::NotFound
        } else {
            ApiError::from(error)
        }
    })?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() || metadata.len() != record.size {
        return Err(ApiError::Internal("资源文件长度与元数据不符".into()));
    }
    let (start, end) = parse_range(headers.get(header::RANGE), record.size)?;
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == format!("\"{}\"", record.sha256))
    {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        set_common_headers(response.headers_mut(), &record);
        return Ok(response);
    }
    let is_partial = record.size > 0 && (start != 0 || end + 1 != record.size);
    let length = if record.size == 0 { 0 } else { end - start + 1 };
    let mut response = if method == Method::HEAD {
        Response::new(Body::empty())
    } else {
        if start != 0 {
            file.seek(std::io::SeekFrom::Start(start)).await?;
        }
        let reader = file.take(length);
        Response::new(Body::from_stream(ReaderStream::new(reader)))
    };
    *response.status_mut() = if is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    set_common_headers(response.headers_mut(), &record);
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())
            .map_err(|_| ApiError::Internal("响应长度无效".into()))?,
    );
    if is_partial {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{}", record.size))
                .map_err(|_| ApiError::Internal("响应范围无效".into()))?,
        );
    }
    Ok(response)
}

fn set_common_headers(headers: &mut HeaderMap, record: &ResourceRecord) {
    if let Ok(value) = HeaderValue::from_str(&record.media_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&format!("\"{}\"", record.sha256)) {
        headers.insert(header::ETAG, value);
    }
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if record.filename.is_ascii() {
        if let Ok(value) = HeaderValue::from_str(&record.filename) {
            headers.insert("x-resource-filename", value);
        }
    } else {
        let filename = percent_encoding::utf8_percent_encode(
            &record.filename,
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        if let Ok(value) = HeaderValue::from_str(&filename) {
            headers.insert("x-resource-filename", value);
            headers.insert(
                "x-resource-filename-encoding",
                HeaderValue::from_static("percent"),
            );
        }
    }
}

async fn catalog(
    State(state): State<AppState>,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<CatalogResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || state.store.catalog(&query)).await??;
    Ok(Json(result))
}

async fn publish_catalog_entry(
    State(state): State<AppState>,
    Json(entry): Json<MarketEntry>,
) -> Result<(StatusCode, Json<MarketEntry>), ApiError> {
    let store = state.store;
    let copy = entry.clone();
    tokio::task::spawn_blocking(move || store.insert_market_entry(&copy)).await??;
    Ok((StatusCode::CREATED, Json(entry)))
}

async fn delete_catalog_entry(
    State(state): State<AppState>,
    Path((id, version)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let removed =
        tokio::task::spawn_blocking(move || state.store.remove_market_entry(&id, &version))
            .await??;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

async fn load_resource(store: Store, id: String) -> Result<ResourceRecord, ApiError> {
    let record = tokio::task::spawn_blocking(move || store.resource(&id)).await??;
    Ok(record)
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn parse_range(value: Option<&HeaderValue>, size: u64) -> Result<(u64, u64), ApiError> {
    if size == 0 {
        return Ok((0, 0));
    }
    let Some(value) = value.and_then(|value| value.to_str().ok()) else {
        return Ok((0, size - 1));
    };
    let Some(range) = value.strip_prefix("bytes=") else {
        return Err(ApiError::Range(size));
    };
    let Some((start, end)) = range.split_once('-') else {
        return Err(ApiError::Range(size));
    };
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ApiError::Range(size))?;
        if suffix == 0 {
            return Err(ApiError::Range(size));
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| ApiError::Range(size))?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ApiError::Range(size))?
                .min(size - 1)
        };
        (start, end)
    };
    if start > end || start >= size {
        return Err(ApiError::Range(size));
    }
    Ok((start, end))
}

#[derive(Debug)]
enum ApiError {
    BadRequest(String),
    NotFound,
    Conflict,
    PayloadTooLarge,
    Range(u64),
    Internal(String),
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Missing => Self::NotFound,
            StoreError::InvalidId => Self::BadRequest("资源标识无效".into()),
            StoreError::Conflict => Self::Conflict,
            StoreError::Metadata(message) => Self::BadRequest(message),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<tokio::task::JoinError> for ApiError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::Internal(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "invalid_request", message),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", "资源不存在".into()),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "conflict",
                "资源或市场条目已存在".into(),
            ),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "上传内容超过限制".into(),
            ),
            Self::Range(size) => {
                let mut response = (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    Json(json!({
                        "error": { "code": "invalid_range", "message": "请求范围无效" }
                    })),
                )
                    .into_response();
                if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                    response.headers_mut().insert(header::CONTENT_RANGE, value);
                }
                return response;
            }
            Self::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
            }
        };
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn upload_and_range_download_keep_original_bytes() {
        let directory = tempfile::tempdir().expect("临时目录");
        let app = router(Store::open(directory.path()).expect("打开资源存储"));
        let request = axum::http::Request::builder()
            .method(Method::POST)
            .uri("/api/v1/resources")
            .header("content-type", "text/plain")
            .header("x-resource-filename", "hello.txt")
            .header("x-resource-kind", "resource")
            .body(Body::from("hello world"))
            .expect("构造上传请求");
        let response = app.clone().oneshot(request).await.expect("上传响应");
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("读取上传响应")
            .to_bytes();
        let record: ResourceRecord = serde_json::from_slice(&bytes).expect("资源记录");
        let request = axum::http::Request::builder()
            .method(Method::GET)
            .uri(format!("/api/v1/resources/{}", record.sha256))
            .header(header::RANGE, "bytes=6-10")
            .body(Body::empty())
            .expect("构造下载请求");
        let response = app.oneshot(request).await.expect("下载响应");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 6-10/11");
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("读取下载响应")
            .to_bytes();
        assert_eq!(&bytes[..], b"world");
    }

    #[tokio::test]
    async fn chinese_filename_is_encoded_for_browser_headers() {
        let directory = tempfile::tempdir().expect("临时目录");
        let app = router(Store::open(directory.path()).expect("打开资源存储"));
        let filename = "设备截图 100%.png";
        let encoded =
            percent_encoding::utf8_percent_encode(filename, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/resources")
                    .header("x-resource-filename", encoded)
                    .header("x-resource-filename-encoding", "percent")
                    .body(Body::from("png"))
                    .expect("构造上传请求"),
            )
            .await
            .expect("上传响应");
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("上传结果")
            .to_bytes();
        let record: ResourceRecord = serde_json::from_slice(&bytes).expect("资源记录");
        assert_eq!(record.filename, filename);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/api/v1/resources/{}", record.sha256))
                    .header(header::ORIGIN, "http://127.0.0.1:5173")
                    .body(Body::empty())
                    .expect("构造下载请求"),
            )
            .await
            .expect("下载响应");
        assert_eq!(
            response.headers()["x-resource-filename-encoding"],
            "percent"
        );
        let returned = response.headers()["x-resource-filename"]
            .to_str()
            .expect("ASCII文件名");
        assert_eq!(
            percent_encoding::percent_decode_str(returned)
                .decode_utf8()
                .expect("文件名解码"),
            filename
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "*"
        );
    }
}
