//! SDK 在进入处理器之前产生的协议错误也必须可关联；成功的大结果保持流式。
use axum::{
    body::{Body, Bytes, to_bytes},
    http::header,
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use serde::de::{self, MapAccess, Visitor};
use serde_json::{Value, json};
use std::fmt;

enum Payload {
    Success,
    Error,
    Unknown,
}
struct Probe;
impl<'de> Visitor<'de> for Probe {
    type Value = Payload;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON-RPC 对象")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Payload, A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                // 以受控标记中止解析；正常返回会要求消耗整个对象。
                "result" => return Err(de::Error::custom("deviceforge_probe_success")),
                "error" => return Err(de::Error::custom("deviceforge_probe_error")),
                _ => {
                    map.next_value::<de::IgnoredAny>()?;
                }
            }
        }
        Ok(Payload::Unknown)
    }
}
fn probe(bytes: &[u8]) -> Result<Payload, serde_json::Error> {
    use serde::Deserializer;
    match serde_json::Deserializer::from_slice(bytes).deserialize_map(Probe) {
        Err(error) if error.to_string().starts_with("deviceforge_probe_success") => {
            Ok(Payload::Success)
        }
        Err(error) if error.to_string().starts_with("deviceforge_probe_error") => {
            Ok(Payload::Error)
        }
        result => result,
    }
}

pub(crate) async fn correlate(response: Response, log_id: &str) -> Response {
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let mut remaining = body.into_data_stream();
    let Some(Ok(mut first)) = remaining.next().await else {
        return Response::from_parts(parts, Body::empty());
    };
    let payload = loop {
        match probe(&first) {
            Ok(value) => break value,
            Err(error) if error.is_eof() && first.len() < 256 * 1024 => {
                match remaining.next().await {
                    Some(Ok(next)) => first = [first.as_ref(), next.as_ref()].concat().into(),
                    _ => break Payload::Unknown,
                }
            }
            _ => break Payload::Unknown,
        }
    };
    // 正常工具响应已由装饰器添加元数据；只扫描到 result 键，不解析工具结果。
    if matches!(payload, Payload::Success) && first.len() > 512 {
        return Response::from_parts(
            parts,
            Body::from_stream(
                stream::once(async move { Ok::<_, axum::Error>(first) }).chain(remaining),
            ),
        );
    }
    let body = Body::from_stream(
        stream::once(async move { Ok::<_, axum::Error>(first) }).chain(remaining),
    );
    let bytes = match to_bytes(body, 512 * 1024).await {
        Ok(value) => value,
        Err(_) => {
            tracing::error!("MCP 诊断响应超过上限或传输失败");
            return (axum::http::StatusCode::BAD_GATEWAY, axum::Json(json!({"log_id":log_id,"error":{"code":"mcp_response_failed","message":"MCP 响应无法完成"}}))).into_response();
        }
    };
    let mut value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Response::from_parts(parts, Body::from(bytes)),
    };
    if let Some(error) = value
        .get_mut("error")
        .filter(|_| matches!(payload, Payload::Error))
    {
        let mut data = error
            .get_mut("data")
            .map(Value::take)
            .unwrap_or_else(|| json!({}));
        if !data.is_object() {
            data = json!({"details":data});
        }
        data["log_id"] = json!(log_id);
        error["data"] = data;
    } else if matches!(payload, Payload::Success) {
        value["result"]["_meta"]["deviceforge/log_id"] = json!(log_id);
    } else if value.get("log_id").is_none() {
        value = json!({"log_id":log_id,"error":value});
    }
    let body = Bytes::from(serde_json::to_vec(&value).expect("JSON 诊断体可序列化"));
    parts.headers.insert(
        header::CONTENT_LENGTH,
        body.len().to_string().parse().expect("长度为数值"),
    );
    Response::from_parts(parts, Body::from(body))
}
