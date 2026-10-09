use axum::{
    extract::{MatchedPath, Request},
    http::{HeaderValue, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use deviceforge_observability::LogContext;
use std::time::Instant;
use tracing::Instrument;

#[derive(Clone)]
pub(crate) struct Correlation {
    pub context: LogContext,
    pub span: tracing::Span,
}

pub(crate) async fn audit(mut request: Request, next: Next) -> Response {
    let context = LogContext::default();
    let is_v2 = request.uri().path().starts_with("/api/v2/");
    let is_mcp = request.uri().path() == "/mcp";
    let is_head = request.method() == axum::http::Method::HEAD;
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("未匹配接口");
    let span =
        tracing::info_span!("请求", log_id = %context.log_id, method = %request.method(), route);
    request.extensions_mut().insert(Correlation {
        context: context.clone(),
        span: span.clone(),
    });
    let started = Instant::now();
    let mut response = context
        .scope(
            async {
                tracing::info!("请求开始");
                let response = next.run(request).await;
                tracing::info!(
                    status = response.status().as_u16(),
                    elapsed_us = started.elapsed().as_micros() as u64,
                    "响应已建立"
                );
                response
            }
            .instrument(span.clone()),
        )
        .await;
    // SDK 传输拒绝可能返回纯文本；只给出受控类别，不回显原始协议或请求。
    if is_mcp
        && response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        let status = response.status();
        response = (status, axum::Json(serde_json::json!({"log_id":context.log_id,"error":{"code":"mcp_transport_rejected","message":"MCP 请求未通过传输校验"}}))).into_response();
    } else if is_v2 {
        response = super::responses::envelope(response, &context.log_id);
    }
    if is_mcp {
        response = context
            .scope(super::mcp_wire::correlate(response, &context.log_id).instrument(span.clone()))
            .await;
    }
    response.headers_mut().insert(
        "x-deviceforge-log-id",
        HeaderValue::from_str(&context.log_id).expect("宿主生成的 UUID 可用作请求头"),
    );
    if is_head {
        response
    } else {
        super::response_stream::track(response, span, started)
    }
}
