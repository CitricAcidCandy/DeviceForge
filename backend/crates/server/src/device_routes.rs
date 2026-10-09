//! 设备 HTTP 薄边界；动作和刷新规则由同一设备服务执行。
use crate::{ApiState,ApiError};
use apk_domain::{Error,Job,devices::*};
use axum::{Json,extract::{State,Path,rejection::{PathRejection,JsonRejection}}};
use serde::Deserialize;

#[derive(Deserialize,schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct RefreshRequest {pub generation:String}
pub(crate) async fn providers(State(state):State<ApiState>)->Json<Vec<DeviceProviderInfo>> {Json(state.devices.providers())}
pub(crate) async fn directories(State(state):State<ApiState>)->Json<Vec<DeviceDirectory>> {Json(state.devices.directories())}
pub(crate) async fn refresh(State(state):State<ApiState>,path:Result<Path<String>,PathRejection>,body:Result<Json<RefreshRequest>,JsonRejection>)->Result<Json<DeviceDirectory>,ApiError> {
    let Path(id)=path.map_err(|_|Error::Invalid("设备提供者路径无效".into()))?;
    let Json(body)=body.map_err(|_|Error::Invalid("刷新要求 generation 对象".into()))?;
    Ok(Json(state.devices.refresh(ProviderInput{id,generation:body.generation}).await?))
}
pub(crate) async fn invoke(State(state):State<ApiState>,body:Result<Json<DeviceActionRequest>,JsonRejection>)->Result<(axum::http::StatusCode,Json<Job>),ApiError> {
    let Json(body)=body.map_err(|_|Error::Invalid("设备动作请求结构无效".into()))?;
    Ok((axum::http::StatusCode::ACCEPTED,Json(state.devices.invoke(body).await?)))
}
