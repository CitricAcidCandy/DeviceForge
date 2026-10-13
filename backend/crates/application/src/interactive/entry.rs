use super::output_cache::OutputCache;
use apk_domain::{Error, Result, interactive::*};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

pub(super) struct Record {
    pub info: SessionInfo,
    pub output: OutputCache,
    pub failure: Option<SessionFailure>,
}

#[derive(Default)]
pub(super) struct InputAdmission {
    pub bytes: usize,
    pub messages: usize,
    pub eof: bool,
}

pub(super) struct Entry {
    pub record: Mutex<Record>,
    pub input: Arc<dyn SessionInput>,
    pub cancel: CancellationToken,
    pub deadline: tokio::time::Instant,
    pub admission: tokio::sync::Mutex<InputAdmission>,
    pub ready: tokio::sync::watch::Sender<Option<SessionResult<()>>>,
}

impl Entry {
    pub fn new(
        info: SessionInfo,
        input: Arc<dyn SessionInput>,
        cancel: CancellationToken,
        deadline: tokio::time::Instant,
        retention: SessionOutputRetention,
    ) -> Self {
        let (ready, _) = tokio::sync::watch::channel(None);
        Self {
            record: Mutex::new(Record {
                info,
                output: OutputCache::new(retention),
                failure: None,
            }),
            input,
            cancel,
            deadline,
            admission: Default::default(),
            ready,
        }
    }

    pub fn snapshot(&self) -> SessionInfo {
        let mut info = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .info
            .clone();
        if info.status != SessionStatus::Finished && self.cancel.is_cancelled() {
            info.status = SessionStatus::Stopping;
        }
        info
    }

    pub fn finished(&self) -> bool {
        self.record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .info
            .status
            == SessionStatus::Finished
    }

    pub fn cancel(&self) {
        if !self.finished() {
            self.cancel.cancel();
            self.input.cancel();
        }
    }

    pub fn fail(&self, error: &Error) {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.failure.get_or_insert_with(|| failure(error));
    }

    pub fn running(&self) {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if record.info.status == SessionStatus::Opening && !self.cancel.is_cancelled() {
            record.info.status = SessionStatus::Running;
        }
    }

    pub fn append(&self, chunk: SessionChunk) -> Result<()> {
        let mut record = self
            .record
            .lock()
            .map_err(|_| Error::Storage("会话输出缓存异常".into()))?;
        if chunk.sequence
            != record
                .info
                .output_sequence
                .checked_add(1)
                .ok_or(Error::TooLarge)?
        {
            return Err(Error::Dependency("会话输出序号无效".into()));
        }
        let sequence = chunk.sequence;
        record.output.append(chunk)?;
        record.info.output_sequence = sequence;
        Ok(())
    }

    pub fn output(&self, after: u64, limit: usize) -> Result<SessionOutputPage> {
        let record = self
            .record
            .lock()
            .map_err(|_| Error::Storage("会话输出读取异常".into()))?;
        if after > record.info.output_sequence {
            return Err(Error::Invalid("会话输出游标超出已保留范围".into()));
        }
        let chunks = record.output.page(after, limit)?;
        let next_sequence = chunks.last().map_or(after, |chunk| chunk.sequence);
        let mut session = record.info.clone();
        if session.status != SessionStatus::Finished && self.cancel.is_cancelled() {
            session.status = SessionStatus::Stopping;
        }
        Ok(SessionOutputPage {
            session,
            chunks,
            next_sequence,
        })
    }

    pub fn finish(&self, exit: &SessionExit, owner: &crate::registry::Owner) {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if record.info.status == SessionStatus::Finished {
            return;
        }
        let cleanup = if exit.cleanup == SessionCleanup::Complete && !exit.process_exited {
            SessionCleanup::Unconfirmed
        } else {
            exit.cleanup
        };
        if cleanup != SessionCleanup::Complete {
            owner.mark_unresolved();
        }
        let failure = record
            .failure
            .clone()
            .or_else(|| exit.failure.as_ref().map(|error| failure(error)));
        let mut outcome = exit.outcome.clone();
        if (cleanup != SessionCleanup::Complete
            || failure.is_some()
            || outcome
                .as_ref()
                .is_some_and(|outcome| outcome.error.is_some()))
            && let Some(outcome) = &mut outcome
        {
            outcome.artifacts.clear();
        }
        record.info.completion = Some(SessionCompletion {
            outcome,
            cleanup,
            process_exited: exit.process_exited,
            sequence: exit.sequence,
            failure,
        });
        record.info.status = SessionStatus::Finished;
        if self.ready.borrow().is_none() {
            self.ready.send_replace(Some(Err(exit
                .failure
                .clone()
                .unwrap_or_else(|| Arc::new(Error::Conflict("会话已结束".into()))))));
        }
    }
}

fn failure(error: &Error) -> SessionFailure {
    SessionFailure {
        code: error.code().into(),
        message: match error {
            Error::Dependency(_) | Error::Storage(_) => "会话依赖或内部状态异常".into(),
            _ => error.to_string(),
        },
    }
}
