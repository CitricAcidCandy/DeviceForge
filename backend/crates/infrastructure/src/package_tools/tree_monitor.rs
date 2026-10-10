//! 周期性树监测按实际工作排空，停止不会丢弃在飞的同步扫描。
use crate::{artifact_files::Temporary, package_tools::worker::Pool};
use apk_domain::{Error, Result};
use deviceforge_android_package_core::Control;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) async fn run(
    pool: Pool,
    root: PathBuf,
    lease: Arc<Temporary>,
    stop: CancellationToken,
    deadline: Option<std::time::Instant>,
    interval: Duration,
    check: fn(&Path, &Control<'_>) -> Result<()>,
) -> Result<()> {
    loop {
        tokio::select! { biased; _ = stop.cancelled() => return Ok(()), _ = tokio::time::sleep(interval) => {} }
        let root = root.clone();
        let lease = lease.clone();
        let work = pool
            .run(stop.clone(), deadline, move |control| {
                let _lease = lease;
                control.check().map_err(super::control_error)?;
                if root.exists() {
                    check(&root, control)?;
                }
                Ok(())
            })
            .await;
        if stop.is_cancelled() && matches!(work, Err(Error::Cancelled | Error::Timeout)) {
            return Ok(());
        }
        work?;
        if deadline.is_some_and(|point| Instant::now() >= Instant::from_std(point)) {
            return Err(Error::Timeout);
        }
    }
}
