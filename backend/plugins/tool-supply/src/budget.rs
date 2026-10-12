//! 同一个原始期限和取消令牌贯穿清单、下载、解压与安装。
use crate::error::{Error, Result};
use std::{future::Future, time::Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Budget {
    pub deadline: Instant,
    pub cancel: CancellationToken,
}
impl Budget {
    pub fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    pub async fn run<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        self.check()?;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(self.deadline)) => Err(Error::Timeout),
            _ = self.cancel.cancelled() => Err(Error::Cancelled),
            result = future => result,
        }
    }
}
