//! 原安卓两项贡献保持输入与结果合同，统一使用资源租约执行。
use crate::{Error, Result, control::Control, model};
use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::Output;
use serde_json::json;
use std::time::Duration;
pub(crate) async fn run(control: &Control, request: &Request, adb: &str) -> Result<Output> {
    let input = model::parse(&request.operation, request.input.clone())
        .map_err(|_| Error::Invalid("安卓设备或动作序列无效"))?;
    let origin = tokio::time::Instant::now();
    let mut dispatched = 0_u64;
    for step in input.steps {
        control.check()?;
        let at = origin + Duration::from_millis(step.at_ms);
        if at > tokio::time::Instant::now() {
            control
                .pause(at.saturating_duration_since(tokio::time::Instant::now()))
                .await?;
        }
        let mut args = vec![
            "-s".into(),
            input.device_id.clone(),
            "shell".into(),
            "input".into(),
        ];
        args.extend(step.action.arguments());
        control.capture(adb, &args, None, None, false).await?;
        dispatched += 1;
    }
    control.check()?;
    Ok(Output::from(
        json!({"device_id":input.device_id,"dispatched":dispatched,"completed":true,"effect_confirmed":false}),
    ))
}
