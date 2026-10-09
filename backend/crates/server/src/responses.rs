use axum::{
    body::{Body, Bytes},
    http::{StatusCode, header},
    response::Response,
};
use futures_util::{StreamExt, stream};
use serde::Serialize;

/// 成功的原始文件传输不参与 JSON 包装，包括 JSON 类型产物。
#[derive(Clone)]
pub(crate) struct RawRepresentation;

#[derive(Serialize, schemars::JsonSchema)]
pub struct Success<T> {
    pub log_id: String,
    pub data: T,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct ErrorResponse {
    pub log_id: String,
    pub error: super::Failure,
}

/// 只拼接 JSON 前后缀，不把实体或列表重新解析到 Value。
pub(crate) fn envelope(response: Response, log_id: &str) -> Response {
    if response.extensions().get::<RawRepresentation>().is_some()
        || response.status() == StatusCode::NO_CONTENT
        || !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value.as_bytes().starts_with(b"application/json"))
    {
        return response;
    }
    let field = if response.status().is_success() {
        "data"
    } else {
        "error"
    };
    let prefix = Bytes::from(format!("{{\"log_id\":\"{log_id}\",\"{field}\":"));
    let (mut parts, body) = response.into_parts();
    if let Some(length) = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if let Some(total) = length.checked_add(prefix.len() as u64 + 1) {
            if let Ok(value) = total.to_string().parse() {
                parts.headers.insert(header::CONTENT_LENGTH, value);
            }
        } else {
            parts.headers.remove(header::CONTENT_LENGTH);
        }
    }
    let stream = stream::once(async move { Ok::<_, axum::Error>(prefix) })
        .chain(body.into_data_stream())
        .chain(stream::once(async { Ok(Bytes::from_static(b"}")) }));
    Response::from_parts(parts, Body::from_stream(stream))
}
