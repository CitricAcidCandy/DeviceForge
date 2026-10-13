//! 持续视频采集生命周期；指标采样与画面接收并行，结束后按PTS抽帧。
mod capture;
mod cleanup;
mod device;
mod extract;
mod rules;
mod tools;
use crate::{Error, Result, config::profile::Profile, profile::models::Sample, session::Session};
use std::path::{Path, PathBuf};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
pub(crate) struct MediaStatus {
    pub status: &'static str,
    pub reason: Option<&'static str>,
}
pub(crate) struct Media {
    device: device::Device,
    device_id: String,
    profile: Profile,
    root: PathBuf,
    before: rules::Anchor,
    stop: CancellationToken,
    reader: Option<JoinHandle<Result<capture::Captured>>>,
    guard: tools::Guard,
}
pub(crate) async fn start(
    session: &Session,
    device_id: &str,
    profile: &Profile,
    root: &Path,
) -> Result<Option<Media>> {
    if profile.scrcpy_server.is_none()
        || profile.clock_helper.is_none()
        || profile.ffmpeg.is_none()
        || profile.ffprobe.is_none()
        || profile.server_version.as_deref() != Some("3.3.1")
    {
        return Ok(None);
    }
    let mut device = device::Device::new();
    let mut guard = tools::Guard::new(session);
    let prepared = async {
        device.prepare(session, device_id, profile).await?;
        let anchor = device.anchor(session, device_id).await?;
        let socket = device.connect(session).await?;
        Ok::<_, Error>((anchor, socket))
    }
    .await;
    let (before, (socket, header)) = match prepared {
        Ok(value) => value,
        Err(error) => {
            let terminal = matches!(
                error,
                Error::Timeout | Error::Cancelled | Error::TooLarge | Error::CleanupFailed
            );
            if device.cleanup(session, device_id, terminal).await.is_err() {
                return Err(Error::CleanupFailed);
            }
            guard.clean = true;
            return Err(error);
        }
    };
    let path = root.join("stream.h264");
    let stop = session.control.context.cancellation().child_token();
    let signal = stop.clone();
    let deadline = session.control.context.deadline().into();
    let reader =
        tokio::spawn(async move { capture::run(socket, header, path, signal, deadline).await });
    Ok(Some(Media {
        device,
        device_id: device_id.into(),
        profile: profile.clone(),
        root: root.into(),
        before,
        stop,
        reader: Some(reader),
        guard,
    }))
}
impl Media {
    pub(crate) async fn stop_and_select(
        &mut self,
        session: &Session,
        samples: &mut [Sample],
        root: &Path,
    ) -> Result<MediaStatus> {
        session.control.check()?;
        let after = self.device.anchor(session, &self.device_id).await?;
        self.stop.cancel();
        let mut reader = self
            .reader
            .take()
            .ok_or(Error::Dependency("视频接收任务已经收口"))?;
        let captured =
            match tokio::time::timeout_at(session.control.context.deadline().into(), &mut reader)
                .await
            {
                Ok(result) => result.map_err(|_| Error::CleanupFailed)?,
                Err(_) => {
                    self.reader = Some(reader);
                    return Err(Error::Timeout);
                }
            };
        self.device.cleanup(session, &self.device_id, false).await?;
        self.guard.clean = true;
        let captured = captured?;
        session
            .work({
                let frames = root.join("frames");
                move |check| {
                    check()?;
                    std::fs::create_dir(&frames).map_err(|_| Error::Io("画面私有目录创建失败"))?;
                    check()?;
                    Ok(())
                }
            })
            .await?;
        let count = extract::extract(
            session,
            &self.profile,
            captured,
            self.before,
            after,
            samples,
            &self.root,
        )
        .await?;
        Ok(MediaStatus {
            status: if count > 0 { "captured" } else { "unavailable" },
            reason: if count > 0 {
                None
            } else {
                Some("视频帧与采样目标的时间差超出允许范围")
            },
        })
    }
    pub(crate) async fn cleanup(&mut self, session: &Session, failed: bool) -> Result<()> {
        self.stop.cancel();
        let deadline = if failed {
            session.control.lease.cleanup_point()?
        } else {
            session.control.context.deadline().into()
        };
        if let Some(mut reader) = self.reader.take() {
            match tokio::time::timeout_at(deadline, &mut reader).await {
                Ok(result) => {
                    if result.is_err() {
                        return Err(Error::CleanupFailed);
                    }
                }
                Err(_) => {
                    self.reader = Some(reader);
                    return Err(Error::CleanupFailed);
                }
            }
        }
        if self.guard.clean {
            return Ok(());
        }
        self.device
            .cleanup(session, &self.device_id, failed)
            .await?;
        self.guard.clean = true;
        Ok(())
    }
}
impl Drop for Media {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
