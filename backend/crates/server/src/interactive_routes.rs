use crate::{ApiError, ApiState, Submit, interactive::*};
use apk_domain::interactive::{SessionInfo, SessionOutputPage};
use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct OutputQuery {
    after: Option<u64>,
    limit: Option<usize>,
}

pub(crate) fn router() -> Router<ApiState> {
    Router::new()
        .route("/api/v2/session-definitions", get(definitions))
        .route("/api/v2/sessions", get(list).post(open))
        .route("/api/v2/sessions/{id}", get(detail).delete(remove))
        .route("/api/v2/sessions/{id}/output", get(output))
        .route("/api/v2/sessions/{id}/input", post(input))
        .route("/api/v2/sessions/{id}/eof", post(eof))
        .route("/api/v2/sessions/{id}/cancel", post(cancel))
        .route("/api/v2/sessions/{id}/release", post(release))
}

async fn definitions(State(state): State<ApiState>) -> Json<SessionDefinitions> {
    let (revision, sessions) = state.app.session_definitions();
    Json(SessionDefinitions { revision, sessions })
}

async fn list(State(state): State<ApiState>) -> Json<Vec<SessionInfo>> {
    Json(state.app.session_records())
}

async fn open(
    State(state): State<ApiState>,
    body: std::result::Result<Json<Submit>, JsonRejection>,
) -> std::result::Result<(StatusCode, Json<SessionInfo>), ApiError> {
    let Json(request) = body
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", "会话打开请求无效"))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(state.app.open_session(&request.operation, request.input)?),
    ))
}

async fn detail(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> std::result::Result<Json<SessionInfo>, ApiError> {
    Ok(Json(state.app.session(&id)?))
}

async fn output(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    query: std::result::Result<Query<OutputQuery>, QueryRejection>,
) -> std::result::Result<Json<SessionOutputPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "会话输出查询参数无效",
        )
    })?;
    Ok(Json(state.app.session_output(
        &id,
        query.after.unwrap_or(0),
        query.limit.unwrap_or(50),
    )?))
}

async fn input(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: std::result::Result<Json<SessionBytesInput>, JsonRejection>,
) -> std::result::Result<Json<SessionReceipt>, ApiError> {
    let Json(request) = body
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", "会话输入字节无效"))?;
    state.app.session_send(&id, &request.bytes).await?;
    Ok(Json(SessionReceipt { id, accepted: true }))
}

async fn eof(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> std::result::Result<Json<SessionReceipt>, ApiError> {
    state.app.session_eof(&id).await?;
    Ok(Json(SessionReceipt { id, accepted: true }))
}

async fn cancel(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> std::result::Result<Json<SessionInfo>, ApiError> {
    Ok(Json(state.app.session_cancel(&id)?))
}

async fn release(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> std::result::Result<(StatusCode, Json<SessionInfo>), ApiError> {
    Ok((StatusCode::ACCEPTED, Json(state.app.session_release(&id)?)))
}

async fn remove(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> std::result::Result<Json<SessionRemoved>, ApiError> {
    state.app.session_remove(&id)?;
    Ok(Json(SessionRemoved { id }))
}
