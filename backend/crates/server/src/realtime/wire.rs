//! 实时消息使用独立可信日志编号，不回显网络载荷和认证材料。

use super::{
    access::PhysicalConnection,
    outbox::{Lane, Outbox},
};
use crate::{ApiError, debugger};
use apk_application::debugger::{DebuggerError, ErrorCode};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use socketioxide::extract::{AckSender, SocketRef, TryData};
use std::sync::Arc;

pub(super) fn failure(code: &str, message: &str) -> Value {
    let context = deviceforge_observability::LogContext::default();
    tracing::warn!(log_id = %context.log_id, code, "实时消息处理失败");
    json!({"log_id": context.log_id, "error": {"code": code, "message": message}})
}

pub(super) fn success<T: Serialize>(event: &str, data: &T) -> Value {
    let context = deviceforge_observability::LogContext::default();
    // 不记录完整正文；编号对应这次事件或回执，与命令身份分开。
    tracing::debug!(log_id = %context.log_id, event, "实时消息已建立");
    json!({"log_id": context.log_id, "data": data})
}

pub(super) fn api_failure(error: ApiError) -> Value {
    failure(&error.1.code, &error.1.message)
}

pub(super) fn debug_failure(error: DebuggerError) -> Value {
    api_failure(debugger::error(error))
}

pub(super) fn invalid(message: &str) -> DebuggerError {
    DebuggerError {
        code: ErrorCode::InvalidInput,
        message: message.into(),
    }
}

pub(super) fn parse<T: DeserializeOwned>(data: TryData<T>) -> Result<T, DebuggerError> {
    data.0
        .map_err(|_| invalid("实时事件的字段或类型不符合契约，请查询调试指南"))
}

pub(super) async fn ack<T: Serialize>(
    socket: &SocketRef,
    outbox: &Arc<Outbox>,
    sender: AckSender,
    event: &'static str,
    result: Result<T, DebuggerError>,
) {
    let value = match result {
        Ok(value) => success(event, &value),
        Err(error) => debug_failure(error),
    };
    if outbox
        .ack(socket.clone(), sender, event, value)
        .await
        .is_err()
    {
        tracing::warn!(
            code = "realtime_backpressure",
            "实时回执队列已满，结束对应命名空间"
        );
        disconnect(socket, Lane::Debugger);
    }
}

pub(super) fn disconnect(socket: &SocketRef, lane: Lane) {
    if let Some(physical) = PhysicalConnection::get(socket) {
        physical.inner.request_disconnect(socket.clone(), lane);
    } else if let Err(error) = socket.clone().disconnect() {
        tracing::warn!(
            ?error,
            code = "realtime_connection_missing",
            "缺少物理关闭归属，命名空间关闭未确认"
        );
    }
}

pub(super) async fn detached(socket: &SocketRef, lane: Lane) {
    if let Some(physical) = PhysicalConnection::get(socket) {
        physical.inner.outbox.stop_lane(lane);
        physical.inner.detached(lane).await;
    }
}

pub(super) fn event<T: Serialize>(
    socket: &SocketRef,
    outbox: &Arc<Outbox>,
    lane: Lane,
    event: &'static str,
    data: &T,
) -> Result<(), ()> {
    outbox.event(socket.clone(), lane, event, success(event, data))
}
