//! 指南采用事务：读缓存不联网，显式更新确认保存后再切换当前正文。
mod rules;
pub use rules::embedded;

use apk_domain::{Error, Result, plugin_guides::*};
use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OnceCell, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideSource {
    Embedded,
    Cached,
    Online,
}

#[derive(Clone)]
pub struct GuideView {
    pub snapshot: Arc<GuideSnapshot>,
    pub source: GuideSource,
    /// 仅保留有界稳定错误类别，不包含正文、部署路径或下载凭据。
    pub diagnostics: Vec<String>,
}

pub struct GuideService {
    builtin: Arc<GuideSnapshot>,
    store: Option<Arc<dyn GuideStore>>,
    active: RwLock<GuideView>,
    initialized: OnceCell<()>,
    update_gate: Mutex<()>,
    parsing: Arc<Semaphore>,
    shutdown: CancellationToken,
}

impl GuideService {
    pub fn new(
        builtin: GuideSnapshot,
        store: Option<Arc<dyn GuideStore>>,
        shutdown: CancellationToken,
    ) -> Result<Arc<Self>> {
        rules::validate(&builtin, builtin.compatibility_version)?;
        let builtin = Arc::new(builtin);
        Ok(Arc::new(Self {
            active: RwLock::new(GuideView {
                snapshot: builtin.clone(),
                source: GuideSource::Embedded,
                diagnostics: Vec::new(),
            }),
            builtin,
            store,
            initialized: OnceCell::new(),
            update_gate: Mutex::new(()),
            parsing: Arc::new(Semaphore::new(2)),
            shutdown,
        }))
    }

    fn view(&self) -> GuideView {
        self.active
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn note(&self, stage: &str, error: &Error) {
        let mut state = self
            .active
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.diagnostics.len() == 16 {
            state.diagnostics.remove(0);
        }
        state.diagnostics.push(format!("{stage}:{}", error.code()));
    }

    fn adopt(&self, snapshot: GuideSnapshot, source: GuideSource) -> GuideView {
        let mut state = self
            .active
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.snapshot = Arc::new(snapshot);
        state.source = source;
        state.clone()
    }

    async fn bounded<T>(
        &self,
        deadline: Instant,
        action: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(Error::Cancelled),
            _ = tokio::time::sleep_until(deadline.into()) => Err(Error::Timeout),
            result = action => result,
        }
    }

    async fn decode(&self, bytes: Vec<u8>, deadline: Instant) -> Result<GuideSnapshot> {
        if bytes.len() > MAX_GUIDE_BYTES {
            return Err(Error::TooLarge);
        }
        let permit = self
            .bounded(deadline, async {
                self.parsing
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| Error::Cancelled)
            })
            .await?;
        let baseline = self.builtin.compatibility_version;
        let parse = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            rules::decode(&bytes, baseline)
        });
        self.bounded(deadline, async {
            parse
                .await
                .map_err(|_| Error::Storage("指南校验工作异常".into()))?
        })
        .await
    }

    /// 第一次只读加载缓存；无缓存或坏缓存均保留内置版本，不启动网络工作。
    pub async fn read(&self) -> GuideView {
        self.initialized
            .get_or_init(|| async {
                let Some(store) = &self.store else {
                    return;
                };
                let deadline = Instant::now() + Duration::from_secs(2);
                let result = self
                    .bounded(deadline, store.load(deadline, self.shutdown.child_token()))
                    .await;
                match result {
                    Ok(Some(bytes)) => match self.decode(bytes, deadline).await {
                        Ok(snapshot) => {
                            self.adopt(snapshot, GuideSource::Cached);
                        }
                        Err(error) => self.note("cache", &error),
                    },
                    Ok(None) => (),
                    Err(error) => self.note("cache", &error),
                }
            })
            .await;
        self.view()
    }

    async fn save(&self, snapshot: GuideSnapshot, deadline: Instant) -> Result<GuideSnapshot> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| Error::Dependency("指南更新存储未配置".into()))?;
        let encoded = snapshot.clone();
        let permit = self
            .bounded(deadline, async {
                self.parsing
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| Error::Cancelled)
            })
            .await?;
        let encode = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            serde_json::to_vec(&encoded).map_err(|_| Error::Invalid("指南快照无法编码".into()))
        });
        let bytes = self
            .bounded(deadline, async {
                encode
                    .await
                    .map_err(|_| Error::Storage("指南编码工作异常".into()))?
            })
            .await?;
        if bytes.len() > MAX_GUIDE_BYTES {
            return Err(Error::TooLarge);
        }
        let saved = self
            .bounded(
                deadline,
                store.save(bytes, deadline, self.shutdown.child_token()),
            )
            .await;
        match saved {
            Err(Error::Timeout | Error::Cancelled) => Err(Error::Conflict(
                "指南缓存提交结果未确认；当前正文未切换，不自动重试".into(),
            )),
            Err(error) => Err(error),
            Ok(()) => Ok(snapshot),
        }
    }

    /// 显式更新最多等待20秒，并发请求快速返回冲突，普通读取不排在更新之后。
    pub async fn update(&self) -> Result<GuideView> {
        let _guard = self
            .update_gate
            .try_lock()
            .map_err(|_| Error::Conflict("另一次指南更新仍在进行".into()))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        self.read().await;
        let result = async {
            let store = self
                .store
                .as_ref()
                .ok_or_else(|| Error::Dependency("指南更新存储未配置".into()))?;
            let bytes = self
                .bounded(
                    deadline,
                    store.download(deadline, self.shutdown.child_token()),
                )
                .await?;
            let snapshot = self.decode(bytes, deadline).await?;
            if snapshot.guide_version < self.view().snapshot.guide_version {
                return Err(Error::Invalid(
                    "在线指南版本较旧，请使用显式reset回到内置版本".into(),
                ));
            }
            let snapshot = self.save(snapshot, deadline).await?;
            Ok(self.adopt(snapshot, GuideSource::Online))
        }
        .await;
        if let Err(error) = &result {
            self.note("update", error);
        }
        result
    }

    /// 显式回退只保存当前宿主内置快照，不联网、不重放业务操作。
    pub async fn reset(&self) -> Result<GuideView> {
        let _guard = self
            .update_gate
            .try_lock()
            .map_err(|_| Error::Conflict("另一次指南更新仍在进行".into()))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        self.read().await;
        let result = self
            .save(self.builtin.as_ref().clone(), deadline)
            .await
            .map(|snapshot| self.adopt(snapshot, GuideSource::Embedded));
        if let Err(error) = &result {
            self.note("reset", error);
        }
        result
    }
}

#[cfg(test)]
mod tests;
