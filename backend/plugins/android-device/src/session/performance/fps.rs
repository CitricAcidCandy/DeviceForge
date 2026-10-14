//! 有资格的游戏图层读取；二进制、等待和身份复核沿原绝对期限。
use super::super::Session;
use crate::{Error, Result, rules::performance::fps};
use apk_plugin_sdk::FrameWindow;
use std::time::{Duration, Instant};

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
    /// FPS 只接受原始参数；普通和 Root 路径共同通过一次安全引用。
    async fn frame_read<T: Send + 'static>(
        &self,
        device_id: &str,
        tail: &[&str],
        parse: impl FnOnce(&str, crate::rules::performance::Check<'_>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.control.check()?;
        let args = crate::profile::root::argv(device_id, self.profile_root.as_ref(), tail);
        let captured = self.control.capture_scoped(&args).await?;
        self.work(move |check| {
            check()?;
            let output = crate::rules::performance::output(&captured.stdout, &captured.stderr)?;
            parse(&output, check)
        })
        .await
    }

    async fn owned_frame_layer(
        &self,
        device_id: &str,
        package: &str,
        pid: u32,
        uid: u32,
        sdk: u32,
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
                fps::owned_layer(&captured.stdout, &package, pid, uid, sdk, check)
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
        let Some(sdk) = self
            .frame_read(device_id, &["getprop", "ro.build.version.sdk"], fps::sdk)
            .await?
        else {
            return Ok(None);
        };
        let Some(layer) = self
            .owned_frame_layer(device_id, package, pid, uid, sdk)
            .await?
        else {
            return Ok(None);
        };
        let argument = layer.name();
        let Some(before) = self
            .frame_read(
                device_id,
                &["dumpsys", "SurfaceFlinger", "--latency", argument],
                fps::snapshot,
            )
            .await?
        else {
            return Ok(None);
        };
        let before_completed = Instant::now();
        let cancellation = self.control.context.cancellation();
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.control.context.deadline().into()) => return Err(Error::Timeout),
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(80)) => {},
        }
        self.control.check()?;
        let Some(after) = self
            .frame_read(
                device_id,
                &["dumpsys", "SurfaceFlinger", "--latency", argument],
                fps::snapshot,
            )
            .await?
        else {
            return Ok(None);
        };
        let after_completed = Instant::now();
        let Some(elapsed_ns) = after_completed
            .checked_duration_since(before_completed)
            .and_then(|elapsed| u64::try_from(elapsed.as_nanos()).ok())
        else {
            return Ok(None);
        };
        let confirmed = self
            .owned_frame_layer(device_id, package, pid, uid, sdk)
            .await?;
        if confirmed.as_ref() != Some(&layer) {
            return Ok(None);
        }
        self.work(move |check| fps::window(&layer, &before, &after, elapsed_ns, check))
            .await
    }
}
