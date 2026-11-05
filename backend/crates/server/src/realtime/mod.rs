//! 宿主公共实时传输：两个命名空间共用物理连接，业务状态仍归原服务。

mod access;
mod debugger;
mod lifecycle;
mod outbox;
mod retry;
mod tasks;
mod types;
mod wire;

pub(crate) use access::{finish_http_request, prepare};
pub(crate) use lifecycle::Lifecycle;
pub use types::*;

use crate::ApiState;
use axum::{
    Json, Router,
    extract::{Request, State},
    handler::Handler,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use socketioxide::{
    SocketIo, TransportType,
    extract::{SocketRef, TryData},
    handler::ConnectHandler,
};
use std::time::Duration;

pub(crate) fn router(_state: &ApiState) -> Router<ApiState> {
    Router::new()
        .route("/api/v2/realtime/capabilities", get(capabilities))
        .route(SOCKET_PATH, get(upgrade))
        .route(&format!("{SOCKET_PATH}/"), get(upgrade))
}

async fn upgrade(State(state): State<ApiState>, request: Request) -> Response {
    let Some(physical) = request
        .extensions()
        .get::<access::PhysicalConnection>()
        .cloned()
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    // 一个 HTTP 升级创建一个库实例，两个命名空间共享它；其 close() 只会关闭这一个物理连接。
    let (layer, io) = SocketIo::builder()
        .req_path(SOCKET_PATH)
        .transports([TransportType::Websocket])
        .ping_interval(Duration::from_secs(25))
        .ping_timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .ack_timeout(Duration::from_secs(5))
        .upgrade_timeout(Duration::from_secs(5))
        .max_buffer_size(8)
        .max_payload(MAX_MESSAGE_BYTES as u64)
        .ws_max_message_size(MAX_MESSAGE_BYTES)
        .ws_max_frame_size(MAX_MESSAGE_BYTES)
        .build_layer();
    if !physical.inner.bind(io.clone()) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    state.gate.realtime_runtime.start(&state.app);

    let app = state.app.clone();
    let token = state.gate.token.clone();
    io.ns(
        "/tasks",
        (move |socket: SocketRef| async move { tasks::connected(socket, app.clone()) }).with(
            move |socket: SocketRef, auth: TryData<Option<NamespaceAuth>>| async move {
                access::authenticate(&socket, auth, &token, false)
            },
        ),
    );

    let app = state.app.clone();
    let debugger = state.debugger.clone();
    let token = state.gate.token.clone();
    io.ns(
        "/debugger",
        (move |socket: SocketRef| async move {
            debugger::connected(socket, debugger.clone(), app.clone())
        })
        .with(
            move |socket: SocketRef, auth: TryData<Option<NamespaceAuth>>| async move {
                access::authenticate(&socket, auth, &token, true)
            },
        ),
    );

    // 复用 Axum 的公开 Handler/Layer 接口调用库服务，无额外网络中继和私有传输 API。
    let handler = (|| async { StatusCode::NOT_FOUND }).layer(layer);
    handler.call(request, ()).await.into_response()
}

async fn capabilities(State(_state): State<ApiState>) -> Json<RealtimeCapabilities> {
    Json(RealtimeCapabilities::default())
}

#[cfg(test)]
mod tests;
