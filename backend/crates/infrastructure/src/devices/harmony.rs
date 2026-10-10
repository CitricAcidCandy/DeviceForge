//! 宿主残余Harmony设备工具：只持HDC来源，不暴露Android入口或argv。
use super::{checked_output, field, parse_hdc};
use crate::process;
use apk_domain::{Device, Error, Executor, Operation, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct HarmonyDeviceTools {
    pub hdc: String,
}

pub(super) async fn list(hdc: &str, cancel: CancellationToken) -> Result<Vec<Device>> {
    let args = vec!["list".into(), "targets".into()];
    let output = process::run(hdc, &args, None, Duration::from_secs(10), cancel, false).await?;
    Ok(parse_hdc(&String::from_utf8_lossy(&output)))
}

pub(super) async fn packages(hdc: &str, input: &Value, cancel: CancellationToken) -> Result<Value> {
    let args = vec![
        "-t".into(),
        field(input, "device_id")?,
        "shell".into(),
        "bm".into(),
        "dump".into(),
        "-a".into(),
    ];
    let output = process::run(hdc, &args, None, Duration::from_secs(30), cancel, false).await?;
    Ok(json!({"output": checked_output(&output)?}))
}

#[async_trait]
impl Executor for HarmonyDeviceTools {
    fn operations(&self) -> Vec<Operation> {
        vec![
            Operation {
                id: "harmony.packages".into(),
                title: "枚举 Harmony 应用".into(),
                input_schema: json!({"type":"object","properties":{"device_id":{"type":"string","minLength":1,"maxLength":200}},"required":["device_id"],"additionalProperties":false}),
                execution: None,
            },
            Operation {
                id: "harmony.devices".into(),
                title: "枚举 Harmony 设备".into(),
                input_schema: json!({"type":"object","additionalProperties":false}),
                execution: None,
            },
        ]
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        match operation {
            "harmony.devices" => serde_json::to_value(list(&self.hdc, cancel).await?)
                .map_err(|error| Error::Dependency(error.to_string())),
            "harmony.packages" => packages(&self.hdc, &input, cancel).await,
            _ => Err(Error::NotFound(operation.into())),
        }
    }
}

#[cfg(test)]
mod tests;
