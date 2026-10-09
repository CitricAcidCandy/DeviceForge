use crate::process;
use apk_domain::{Device, Error, Executor, Operation, Result, identifier};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct DeviceTools {
    pub adb: String,
    pub hdc: String,
}
pub fn parse_adb(output: &str) -> Vec<Device> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let id = parts.next()?;
            let state = parts.next()?;
            if ![
                "device",
                "offline",
                "unauthorized",
                "recovery",
                "sideload",
                "bootloader",
            ]
            .contains(&state)
            {
                return None;
            }
            Some(Device {
                id: id.into(),
                platform: "android".into(),
                state: state.into(),
                model: parts.find_map(|s| s.strip_prefix("model:").map(str::to_owned)),
            })
        })
        .collect()
}
pub fn parse_hdc(output: &str) -> Vec<Device> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('['))
        .filter_map(|id| {
            identifier(id).ok()?;
            Some(Device {
                id: id.into(),
                platform: "harmony".into(),
                state: "device".into(),
                model: None,
            })
        })
        .collect()
}
fn field(input: &Value, key: &str) -> Result<String> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid(format!("缺少字符串字段 {key}")))?;
    identifier(value)?;
    Ok(value.into())
}
impl DeviceTools {
    pub async fn list(&self, platform: &str, cancel: CancellationToken) -> Result<Vec<Device>> {
        let (exe, args) = match platform {
            "android" => (&self.adb, vec!["devices".into(), "-l".into()]),
            "harmony" => (&self.hdc, vec!["list".into(), "targets".into()]),
            _ => return Err(Error::Invalid("未知设备平台".into())),
        };
        let output = process::run(exe, &args, None, Duration::from_secs(10), cancel, false).await?;
        let output = String::from_utf8_lossy(&output);
        Ok(if platform == "android" {
            parse_adb(&output)
        } else {
            parse_hdc(&output)
        })
    }
}
#[async_trait]
impl Executor for DeviceTools {
    fn operations(&self) -> Vec<Operation> {
        let mut operations: Vec<Operation> = [
            ("android.connect", "连接远程 Android 设备", "address"),
            ("android.disconnect", "断开远程 Android 设备", "address"),
            ("android.app.start", "启动 Android 应用", "package"),
            ("android.app.stop", "停止 Android 应用", "package"),
            ("android.packages", "枚举 Android 应用", "device_id"),
            ("harmony.packages", "枚举 Harmony 应用", "device_id"),
        ].into_iter().map(|(id, title, key)| {
            let mut properties = serde_json::Map::new();
            properties.insert(key.into(), json!({"type":"string", "minLength":1, "maxLength":200}));
            let mut required = vec![key];
            if !id.ends_with("connect") && key != "device_id" {
                properties.insert("device_id".into(), json!({"type":"string", "minLength":1})); required.push("device_id");
            }
            Operation { id: id.into(), title: title.into(), input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}) }
        }).collect();
        for (id, title) in [
            ("android.devices", "枚举 Android 设备"),
            ("harmony.devices", "枚举 Harmony 设备"),
        ] {
            operations.push(Operation {
                id: id.into(),
                title: title.into(),
                input_schema: json!({"type":"object","additionalProperties":false}),
            });
        }
        operations
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if matches!(operation, "android.devices" | "harmony.devices") {
            let platform = operation.split('.').next().unwrap_or_default();
            return serde_json::to_value(self.list(platform, cancel).await?)
                .map_err(|e| Error::Dependency(e.to_string()));
        }
        let mut exe = &self.adb;
        let args = match operation {
            "android.connect" | "android.disconnect" => {
                let address = field(&input, "address")?;
                if !address.contains(':') {
                    return Err(Error::Invalid("远程地址必须包含端口".into()));
                }
                vec![
                    operation.split('.').nth(1).unwrap_or_default().into(),
                    address,
                ]
            }
            "android.app.start" => vec![
                "-s".into(),
                field(&input, "device_id")?,
                "shell".into(),
                "monkey".into(),
                "-p".into(),
                field(&input, "package")?,
                "-c".into(),
                "android.intent.category.LAUNCHER".into(),
                "1".into(),
            ],
            "android.app.stop" => vec![
                "-s".into(),
                field(&input, "device_id")?,
                "shell".into(),
                "am".into(),
                "force-stop".into(),
                field(&input, "package")?,
            ],
            "android.packages" => vec![
                "-s".into(),
                field(&input, "device_id")?,
                "shell".into(),
                "pm".into(),
                "list".into(),
                "packages".into(),
            ],
            "harmony.packages" => {
                exe = &self.hdc;
                vec![
                    "-t".into(),
                    field(&input, "device_id")?,
                    "shell".into(),
                    "bm".into(),
                    "dump".into(),
                    "-a".into(),
                ]
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        let timeout = if operation == "android.connect" {
            Duration::from_secs(5)
        } else {
            Duration::from_secs(30)
        };
        let output = process::run(exe, &args, None, timeout, cancel, false).await?;
        let output = String::from_utf8_lossy(&output).trim().to_owned();
        let lower = output.to_lowercase();
        if [
            "failed",
            "unable",
            "cannot",
            "error:",
            "no devices",
            "device offline",
            "monkey aborted",
            "no activities",
        ]
        .iter()
        .any(|s| lower.contains(s))
        {
            return Err(Error::Dependency(output));
        }
        if operation == "android.connect"
            && !(lower.starts_with("connected to ") || lower.starts_with("already connected to "))
        {
            return Err(Error::Dependency("远程连接未返回明确成功结果".into()));
        }
        Ok(json!({"output":output}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_states_and_headers() {
        let devices = parse_adb(
            "List of devices attached\na device product:p model:Pixel\nb unauthorized\nc offline\n* daemon started successfully *",
        );
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[0].model.as_deref(), Some("Pixel"));
        assert_eq!(devices[1].state, "unauthorized");
        assert!(parse_hdc("[Empty]\n").is_empty());
    }
}
