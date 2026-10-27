//! HTTP/MCP 共享公共服务用例；任务查询、取消与事件继续使用既有 Job。
use crate::{ApiError, ApiState};
use apk_domain::{Error, Job, Result, services::*};
use axum::{
    Json,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) async fn list(
    State(state): State<ApiState>,
) -> std::result::Result<Json<Vec<ServiceInfo>>, ApiError> {
    Ok(Json(state.app.services()?))
}
pub(crate) async fn call(
    State(state): State<ApiState>,
    path: std::result::Result<Path<String>, PathRejection>,
    body: std::result::Result<Json<ServiceCallRequest>, JsonRejection>,
) -> std::result::Result<(StatusCode, Json<Job>), ApiError> {
    let Path(id) = path.map_err(|_| Error::Invalid("服务 ID 路径无效".into()))?;
    let Json(body) = body.map_err(|_| Error::Invalid("服务调用请求结构无效".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(state.app.call_service(id, body).await?),
    ))
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct McpCall {
    id: String,
    #[serde(deserialize_with = "apk_domain::services::service_version")]
    #[schemars(length(min = 1, max = 128))]
    version: String,
    input: Value,
    #[serde(default)]
    generation: Option<String>,
}

pub(crate) fn tools() -> Vec<rmcp::model::Tool> {
    [
        (
            "deviceforge.list_services",
            "列出公共服务精确版本、契约、代际及入口可用性",
            json!({"type":"object","additionalProperties":false}),
        ),
        (
            "deviceforge.call_service",
            "调用公共服务并返回共享 Job",
            crate::openapi::schema::<McpCall>(),
        ),
    ]
    .into_iter()
    .map(|(name, description, schema)| {
        rmcp::model::Tool::new(
            name,
            description,
            schema.as_object().expect("对象模式").clone(),
        )
    })
    .collect()
}

pub(crate) async fn invoke(
    app: &Arc<apk_application::Application>,
    name: &str,
    input: Value,
) -> Result<Value> {
    let value = match name {
        "deviceforge.list_services" => {
            if input != json!({}) {
                return Err(Error::Invalid("服务目录不接收参数".into()));
            }
            serde_json::to_value(app.services()?)
        }
        "deviceforge.call_service" => {
            let input: McpCall = serde_json::from_value(input)
                .map_err(|_| Error::Invalid("服务调用参数无效".into()))?;
            serde_json::to_value(
                app.call_service(
                    input.id,
                    ServiceCallRequest {
                        version: input.version,
                        input: input.input,
                        generation: input.generation,
                    },
                )
                .await?,
            )
        }
        _ => return Err(Error::NotFound("服务工具不存在".into())),
    };
    value.map_err(|_| Error::Dependency("服务结果序列化失败".into()))
}

pub(crate) fn contribute(document: &mut Value) {
    use crate::openapi::{endpoint, schema, v2_endpoint};
    for (name, value) in [
        ("ServiceRef", schema::<ServiceRef>()),
        ("ServiceContract", schema::<ServiceContract>()),
        ("ServiceProvider", schema::<ServiceProvider>()),
        ("ServiceInfo", schema::<ServiceInfo>()),
        ("ServiceCallRequest", schema::<ServiceCallRequest>()),
    ] {
        document["components"]["schemas"][name] = value;
    }
    let list = v2_endpoint(endpoint(
        "公共服务目录",
        "200",
        schema::<Vec<ServiceInfo>>(),
    ));
    let mut call = v2_endpoint(endpoint("提交公共服务调用任务", "202", schema::<Job>()));
    call["parameters"] =
        json!([{"name":"id","in":"path","required":true,"schema":{"type":"string"}}]);
    call["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":schema::<ServiceCallRequest>()}}});
    document["paths"]["/api/v2/services"] = json!({"get":list});
    document["paths"]["/api/v2/services/{id}/calls"] = json!({"post":call});
}
