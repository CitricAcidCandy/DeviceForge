use super::{MESSAGE_LIMIT, entry::Entry};
use apk_domain::{Error, Result, interactive::SessionStatus};

impl Entry {
    fn available(&self) -> Result<()> {
        if tokio::time::Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if self.snapshot().status == SessionStatus::Finished {
            return Err(Error::Conflict("会话已结束".into()));
        }
        Ok(())
    }

    async fn wait_ready(&self) -> Result<()> {
        let mut ready = self.ready.subscribe();
        loop {
            self.available()?;
            if let Some(result) = ready.borrow().clone() {
                return result.map_err(|error| copy_error(&error));
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(Error::Cancelled),
                _ = tokio::time::sleep_until(self.deadline) => return Err(Error::Timeout),
                changed = ready.changed() => if changed.is_err() { return Err(Error::CleanupFailed); },
            }
        }
    }

    pub async fn admit(&self, bytes: Option<&[u8]>) -> Result<()> {
        if bytes.is_some_and(|bytes| bytes.len() > 8192) {
            return Err(Error::TooLarge);
        }
        self.wait_ready().await?;
        let mut admission = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep_until(self.deadline) => return Err(Error::Timeout),
            admission = self.admission.lock() => admission,
        };
        self.available()?;
        if admission.eof {
            return Err(Error::Conflict("会话输入已交付EOF".into()));
        }
        let total = admission
            .bytes
            .checked_add(bytes.map_or(0, <[u8]>::len))
            .filter(|bytes| *bytes <= 1024 * 1024)
            .ok_or(Error::TooLarge)?;
        if admission.messages >= MESSAGE_LIMIT {
            return Err(Error::TooLarge);
        }
        let accepted = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep_until(self.deadline) => return Err(Error::Timeout),
            result = async {
                match bytes { Some(bytes) => self.input.send(bytes).await, None => self.input.eof().await }
            } => result,
        };
        accepted.map_err(|error| copy_error(&error))?;
        admission.bytes = total;
        admission.messages += 1;
        admission.eof = bytes.is_none();
        Ok(())
    }
}

fn copy_error(error: &Error) -> Error {
    match error {
        Error::Invalid(message) => Error::Invalid(message.clone()),
        Error::TooLarge => Error::TooLarge,
        Error::NotFound(message) => Error::NotFound(message.clone()),
        Error::Conflict(message) => Error::Conflict(message.clone()),
        Error::Cancelled => Error::Cancelled,
        Error::Timeout => Error::Timeout,
        Error::CleanupFailed => Error::CleanupFailed,
        Error::Dependency(_) => Error::Dependency("会话输入依赖异常".into()),
        Error::Storage(_) => Error::Storage("会话输入状态异常".into()),
    }
}
