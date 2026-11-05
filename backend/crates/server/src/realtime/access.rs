//! 只有精确的实时升级路由延后令牌校验；连接身份和容量在升级前核对。

use super::{
    lifecycle::{ConnectionResources, Lifecycle, TransportGuard},
    types::SOCKET_PATH,
    wire,
};
use crate::{ApiError, client_connection::ClientConnection};
use axum::{
    extract::{ConnectInfo, Request},
    http::{Method, StatusCode, Uri, header},
    response::Response,
};
use socketioxide::extract::{SocketRef, TryData};
use std::sync::Arc;
use tokio::sync::OwnedSemaphorePermit;

pub(crate) fn finish_http_request(
    mut response: Response,
    permit: OwnedSemaphorePermit,
) -> Response {
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        // 物理连接已经取得独立额度；升级后不得继续占用普通业务的请求许可。
        drop(permit);
    } else {
        response
            .extensions_mut()
            .insert(crate::response_stream::RequestPermit {
                _permit: Arc::new(permit),
            });
    }
    response
}

#[derive(Clone)]
pub(super) struct PhysicalConnection {
    pub(super) inner: Arc<ConnectionResources>,
    _transport: Arc<TransportGuard>,
}

impl PhysicalConnection {
    pub(super) fn get(socket: &SocketRef) -> Option<Self> {
        socket.req_parts().extensions.get::<Self>().cloned()
    }
}

pub(crate) fn socket_path(path: &str) -> bool {
    path == SOCKET_PATH || path.strip_suffix('/') == Some(SOCKET_PATH)
}

pub(crate) fn prepare(request: &mut Request, runtime: Arc<Lifecycle>) -> Result<bool, ApiError> {
    if !socket_path(request.uri().path()) {
        return Ok(false);
    }
    let invalid = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "realtime_upgrade_required",
            "实时接口仅接受 WebSocket 升级连接",
        )
    };
    let query = request.uri().query().unwrap_or("");
    let transport = query
        .split('&')
        .filter_map(|item| item.split_once('='))
        .collect::<Vec<_>>();
    if request.method() != Method::GET
        || !request
            .headers()
            .get(header::UPGRADE)
            .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
        || !request
            .headers()
            .get(header::CONNECTION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
            })
        || transport
            .iter()
            .filter(|(key, _)| *key == "transport")
            .map(|(_, value)| *value)
            .collect::<Vec<_>>()
            != ["websocket"]
        || transport
            .iter()
            .filter(|(key, _)| *key == "EIO")
            .map(|(_, value)| *value)
            .collect::<Vec<_>>()
            != ["4"]
        || transport.iter().any(|(key, _)| *key == "sid")
    {
        return Err(invalid());
    }
    if request
        .extensions()
        .get::<ConnectInfo<ClientConnection>>()
        .is_none()
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "realtime_connection_required",
            "实时连接缺少真实网络身份",
        ));
    }
    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    if let Some(origin) = origins.next() {
        let valid = origins.next().is_none()
            && origin
                .to_str()
                .ok()
                .and_then(|value| value.parse::<Uri>().ok())
                .is_some_and(|uri| {
                    matches!(uri.scheme_str(), Some("http" | "https"))
                        && uri.host().is_some()
                        && uri
                            .authority()
                            .is_some_and(|authority| !authority.as_str().contains('@'))
                        && uri.path() == "/"
                        && uri.query().is_none()
                });
        if !valid {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "realtime_origin_rejected",
                "实时连接网页来源格式无效",
            ));
        }
    }
    let inner = runtime.admit().ok_or_else(|| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "realtime_capacity",
            "实时连接容量已满，普通业务仍可使用",
        )
    })?;
    let transport = inner.track_transport();
    request.extensions_mut().insert(PhysicalConnection {
        inner,
        _transport: transport,
    });
    Ok(true)
}

pub(super) fn authenticate(
    socket: &SocketRef,
    auth: TryData<Option<super::NamespaceAuth>>,
    token: &str,
    local_only: bool,
) -> Result<(), String> {
    let validate = || {
        if PhysicalConnection::get(socket).is_none() {
            return Err(wire::failure(
                "realtime_connection_required",
                "实时连接尚未通过升级准入",
            ));
        }
        if local_only {
            crate::debugger::check(socket.req_parts()).map_err(wire::api_failure)?;
        }
        let auth = auth
            .0
            .map_err(|_| wire::failure("unauthorized", "命名空间认证格式无效"))?
            .unwrap_or_default();
        if !token.is_empty() && auth.token.as_deref() != Some(token) {
            return Err(wire::failure("unauthorized", "需要有效的访问令牌"));
        }
        Ok(())
    };
    // 认证只做有界内存检查，没有异步或外部等待，受库的五秒连接期限约束。
    validate().map_err(|value| value.to_string())
}
