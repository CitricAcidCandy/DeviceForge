use crate::process;
use apk_domain::{
    Error, Result,
    device_input::{DeviceInput, InputAction, InputReceipt, InputRequest},
};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub struct AndroidInput {
    adb: String,
    devices: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}
// ADB 会重新拼接设备端参数；单引号内的单引号必须先退出引用再转义。
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn text_arguments(text: &str) -> Vec<String> {
    let mut remaining = text;
    let mut parts = Vec::new();
    // 拆开字面量 %s，避免设备输入工具把它误当为空格。
    while let Some(index) = remaining.find("%s") {
        let end = index + 1;
        parts.push(quote(&remaining[..end].replace(' ', "%s")));
        remaining = &remaining[end..];
    }
    if !remaining.is_empty() {
        parts.push(quote(&remaining.replace(' ', "%s")));
    }
    parts
}
fn commands(action: &InputAction) -> Vec<Vec<String>> {
    match action {
        InputAction::Tap { x, y } => vec![vec!["tap".into(), x.to_string(), y.to_string()]],
        InputAction::Swipe {
            x1,
            y1,
            x2,
            y2,
            duration_ms,
        } => vec![vec![
            "swipe".into(),
            x1.to_string(),
            y1.to_string(),
            x2.to_string(),
            y2.to_string(),
            duration_ms.to_string(),
        ]],
        InputAction::Keyevent {
            key_code,
            long_press,
        } => {
            let mut args = vec!["keyevent".into()];
            if *long_press {
                args.push("--longpress".into());
            }
            args.push(key_code.to_string());
            vec![args]
        }
        InputAction::Text { text, enter } => {
            let mut all: Vec<_> = text_arguments(text)
                .into_iter()
                .map(|value| vec!["text".into(), value])
                .collect();
            if *enter {
                all.push(vec!["keyevent".into(), "66".into()]);
            }
            all
        }
    }
}
impl AndroidInput {
    pub fn new(adb: String) -> Self {
        Self {
            adb,
            devices: Mutex::new(HashMap::new()),
        }
    }
    fn device_lock(&self, device_id: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
        let mut devices = self
            .devices
            .lock()
            .map_err(|_| Error::Dependency("设备输入锁不可用".into()))?;
        // 只保留仍有调用持有的锁，避免设备编号不断增加造成常驻内存增长。
        devices.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = devices.get(device_id).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        devices.insert(device_id.into(), Arc::downgrade(&lock));
        Ok(lock)
    }
    async fn dispatch_with_timeout(
        &self,
        request: InputRequest,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<InputReceipt> {
        request.validate()?;
        let deadline = Instant::now() + timeout;
        let device_lock = self.device_lock(&request.device_id)?;
        let _guard = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout_at(deadline, device_lock.lock()) => value.map_err(|_| Error::Timeout)?,
        };
        for command in commands(&request.action) {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(Error::Timeout)?;
            let mut args = vec![
                "-s".into(),
                request.device_id.clone(),
                "shell".into(),
                "-T".into(),
                "input".into(),
            ];
            args.extend(command);
            let output = process::run_text(&self.adb, &args, remaining, cancel.clone())
                .await
                .map_err(|error| match error {
                    // 设备诊断可能包含输入文本，不将其写入持久化任务错误。
                    Error::Dependency(_) => Error::Dependency("Android 输入命令执行失败".into()),
                    other => other,
                })?;
            if !output.is_empty() {
                return Err(Error::Dependency(
                    "Android 输入命令返回诊断信息，无法确认执行成功".into(),
                ));
            }
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        Ok(InputReceipt {
            device_id: request.device_id,
            action: request.action.kind().into(),
            dispatched: true,
        })
    }
}
#[async_trait]
impl DeviceInput for AndroidInput {
    async fn dispatch(
        &self,
        request: InputRequest,
        cancel: CancellationToken,
    ) -> Result<InputReceipt> {
        self.dispatch_with_timeout(request, cancel, Duration::from_secs(30))
            .await
    }
}
#[cfg(test)]
mod tests;
