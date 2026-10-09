//! 设备 MCP 公开工具，HTTP 与此边界使用同一个应用服务。
use apk_application::devices::DeviceService;
use apk_domain::{Error,Result,devices::*};
use rmcp::model::Tool;
use serde_json::{Value,json};
use std::sync::Arc;
pub(crate) fn tools()->Vec<Tool> {
    [("deviceforge.list_device_providers","列出当前设备提供者",json!({"type":"object","additionalProperties":false})),
    ("deviceforge.list_devices","列出当前代观测设备目录",json!({"type":"object","additionalProperties":false})),
    ("deviceforge.refresh_devices","显式刷新指定提供者代际",serde_json::to_value(schemars::schema_for!(ProviderInput)).expect("公开模式有效")),
    ("deviceforge.invoke_device","按能力精确版本提交共享任务",serde_json::to_value(schemars::schema_for!(DeviceActionRequest)).expect("公开模式有效"))]
    .into_iter().map(|(name,description,schema)|Tool::new(name,description,schema.as_object().expect("对象模式").clone())).collect()
}
pub(crate) async fn invoke(service:&Arc<DeviceService>,name:&str,input:Value)->Result<Value> {
    let result=match name {
        "deviceforge.list_device_providers"|"deviceforge.list_devices"=>{
            if input!=json!({}) {return Err(Error::Invalid("设备列表不接受参数".into()));}
            if name.ends_with("list_devices"){serde_json::to_value(service.directories())}else{serde_json::to_value(service.providers())}
        },
        "deviceforge.refresh_devices"=>serde_json::to_value(service.refresh(serde_json::from_value(input).map_err(|_|Error::Invalid("刷新参数无效".into()))?).await?),
        "deviceforge.invoke_device"=>serde_json::to_value(service.invoke(serde_json::from_value(input).map_err(|_|Error::Invalid("设备动作参数无效".into()))?).await?),
        _=>return Err(Error::NotFound("设备工具不存在".into())),
    };
    result.map_err(|_|Error::Dependency("设备结果编码失败".into()))
}
