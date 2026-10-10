use apk_domain::artifacts::ArtifactStore;
use apk_domain::{Error, Executor, Operation, Result, identifier};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::fs::File;
use tokio_util::{io::ReaderStream, sync::CancellationToken};

use crate::{
    artifact_files::{LIMIT, Temporary, materialize},
    process,
};
const TIMEOUT: Duration = Duration::from_secs(120);

mod remaining;
pub use remaining::RemainingDeviceArtifactActions;

pub struct DeviceArtifactActions {
    pub adb: String,
    pub hdc: String,
    pub artifacts: Arc<dyn ArtifactStore>,
}
fn field(input: &Value, key: &str) -> Result<String> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid(format!("缺少字符串参数 {key}")))?;
    identifier(value)?;
    Ok(value.into())
}
fn package(value: &str) -> Result<()> {
    if value.len() > 200
        || !value.contains('.')
        || !value.split('.').all(|part| {
            part.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
    {
        return Err(Error::Invalid(
            "包名必须为点分隔的字母、数字或下划线，段首为字母".into(),
        ));
    }
    Ok(())
}
fn success(output: &str, harmony: bool, install: bool) -> Result<()> {
    let lower = output.to_ascii_lowercase();
    if [
        "failure",
        "failed",
        "error",
        "unable",
        "cannot",
        "offline",
        "no devices",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return Err(Error::Dependency(output.into()));
    }
    let confirmed = if harmony {
        let action = if install { "install" } else { "uninstall" };
        lower.lines().any(|line| {
            line.trim()
                .ends_with(&format!("msg:{action} bundle successfully."))
        })
    } else {
        output.lines().any(|line| line.trim() == "Success")
    };
    if !confirmed {
        return Err(Error::Dependency("工具未返回明确成功结果".into()));
    }
    Ok(())
}
impl DeviceArtifactActions {
    async fn install(
        &self,
        input: &Value,
        harmony: bool,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let device = field(input, "device_id")?;
        let id = field(input, "artifact_id")?;
        let extension = if harmony { ".hap" } else { ".apk" };
        let prepared =
            materialize(self.artifacts.as_ref(), &id, &[extension], cancel.clone()).await?;
        let path = &prepared.path;
        let artifact = &prepared.artifact;
        let args = vec![
            if harmony { "-t" } else { "-s" }.into(),
            device,
            "install".into(),
            path.to_string_lossy().into_owned(),
        ];
        let output = process::run_text(
            if harmony { &self.hdc } else { &self.adb },
            &args,
            TIMEOUT,
            cancel,
        )
        .await?;
        success(&output, harmony, true)?;
        let output = output.replace(path.to_string_lossy().as_ref(), &artifact.filename);
        Ok(json!({"artifact_id": artifact.id, "output":output}))
    }
    async fn screenshot(&self, input: &Value, cancel: CancellationToken) -> Result<Value> {
        let device = field(input, "device_id")?;
        let directory = Temporary::new()?;
        let path = directory.path().join("screenshot.png");
        let mut file = File::create(&path)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        let args = vec![
            "-s".into(),
            device,
            "exec-out".into(),
            "screencap".into(),
            "-p".into(),
        ];
        let result = process::run_to_file(
            &self.adb,
            &args,
            &mut file,
            LIMIT,
            Duration::from_secs(30),
            cancel.clone(),
        )
        .await;
        drop(file);
        result?;
        let file = File::open(&path)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        let stream = ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()));
        let artifact = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::Cancelled),
            value = tokio::time::timeout(TIMEOUT, self.artifacts.put("screenshot.png".into(), Box::pin(stream))) => value.unwrap_or(Err(Error::Timeout)),
        }?;
        serde_json::to_value(artifact).map_err(|e| Error::Storage(e.to_string()))
    }
}
#[async_trait]
impl Executor for DeviceArtifactActions {
    fn operations(&self) -> Vec<Operation> {
        [
            ("android.app.install", "安装 Android APK", Some("artifact_id")),
            ("android.app.uninstall", "卸载 Android 应用", Some("package")),
            ("android.screenshot", "保存 Android 截图", None),
            ("harmony.app.install", "安装 Harmony HAP", Some("artifact_id")),
            ("harmony.app.uninstall", "卸载 Harmony 应用", Some("package")),
        ].into_iter().map(|(id, title, extra)| {
            let mut properties = json!({"device_id":{"type":"string","minLength":1,"maxLength":200}});
            let mut required = vec!["device_id"];
            if let Some(key) = extra {
                properties[key] = json!({"type":"string","minLength":1,"maxLength":200});
                required.push(key);
            }
            Operation { id:id.into(), title:title.into(), input_schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}), execution: None }
        }).collect()
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        match operation {
            "android.app.install" => self.install(&input, false, cancel).await,
            "harmony.app.install" => self.install(&input, true, cancel).await,
            "android.screenshot" => self.screenshot(&input, cancel).await,
            "android.app.uninstall" | "harmony.app.uninstall" => {
                let harmony = operation.starts_with("harmony.");
                let device = field(&input, "device_id")?;
                let name = field(&input, "package")?;
                package(&name)?;
                let args = vec![
                    if harmony { "-t" } else { "-s" }.into(),
                    device,
                    "uninstall".into(),
                    name,
                ];
                let output = process::run_text(
                    if harmony { &self.hdc } else { &self.adb },
                    &args,
                    TIMEOUT,
                    cancel,
                )
                .await?;
                success(&output, harmony, false)?;
                Ok(json!({"output":output}))
            }
            _ => Err(Error::NotFound(operation.into())),
        }
    }
}
#[cfg(test)]
mod tests;
