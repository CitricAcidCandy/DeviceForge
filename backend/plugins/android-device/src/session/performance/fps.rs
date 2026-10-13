//! 有资格的游戏图层读取；二进制、等待和身份复核沿原绝对期限。
use super::super::Session;
use crate::{Error, Result, rules::performance::fps};
use apk_plugin_sdk::FrameWindow;
use std::time::Duration;

impl Session {
    pub(super) async fn frame_window(
        &self,
        device_id: &str,
        package: &str,
        pid: u32,
        uid: u32,
    ) -> Result<Option<FrameWindow>> {
        let result = self.read_frame_window(device_id, package, pid, uid).await;
        self.control.check()?;
        match result {
            Err(Error::Dependency(_)) => Ok(None),
            other => other,
        }
    }
    async fn owned_frame_layer(
        &self,
        device_id: &str,
        package: &str,
        pid: u32,
        uid: u32,
    ) -> Result<Option<fps::Layer>> {
        self.control.check()?;
        let args = [
            "-s",
            device_id,
            "exec-out",
            "dumpsys",
            "SurfaceFlinger",
            "--proto",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let captured = self.control.capture_scoped(&args).await?;
        let package = package.to_owned();
        let qualification = self
            .work(move |check| {
                check()?;
                // 原二进制只从stdout解码；stderr非空表示接口未给出可靠归属。
                if !captured.stderr.iter().all(u8::is_ascii_whitespace) {
                    return Ok(None);
                }
                fps::owned_layer(&captured.stdout, &package, pid, uid, check)
            })
            .await?;
        match qualification {
            Some(fps::Qualification::Owned(layer)) => Ok(Some(layer)),
            Some(fps::Qualification::Window(directory)) => {
                let args = [
                    "-s", device_id, "shell", "-T", "dumpsys", "window", "windows",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
                let captured = self.control.capture_scoped(&args).await?;
                self.work(move |check| {
                    check()?;
                    if !captured.stderr.iter().all(u8::is_ascii_whitespace) {
                        return Ok(None);
                    }
                    let Ok(output) = std::str::from_utf8(&captured.stdout) else {
                        return Ok(None);
                    };
                    directory.window_layer(output, check)
                })
                .await
            }
            None => Ok(None),
        }
    }
    async fn read_frame_window(
        &self,
        device_id: &str,
        package: &str,
        pid: u32,
        uid: u32,
    ) -> Result<Option<FrameWindow>> {
        let Some(layer) = self.owned_frame_layer(device_id, package, pid, uid).await? else {
            return Ok(None);
        };
        let argument = layer.shell_argument();
        let Some(before) = self
            .performance_read(
                device_id,
                &["dumpsys", "SurfaceFlinger", "--latency", &argument],
                fps::snapshot,
            )
            .await?
        else {
            return Ok(None);
        };
        let cancellation = self.control.context.cancellation();
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.control.context.deadline().into()) => return Err(Error::Timeout),
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(80)) => {},
        }
        self.control.check()?;
        let Some(after) = self
            .performance_read(
                device_id,
                &["dumpsys", "SurfaceFlinger", "--latency", &argument],
                fps::snapshot,
            )
            .await?
        else {
            return Ok(None);
        };
        let confirmed = self.owned_frame_layer(device_id, package, pid, uid).await?;
        if confirmed.as_ref() != Some(&layer) {
            return Ok(None);
        }
        self.work(move |check| fps::window(&layer, &before, &after, check))
            .await
    }
}
