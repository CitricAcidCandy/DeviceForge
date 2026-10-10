use apk_domain::{
    Result,
    artifacts::{ArchivePage, Artifact, ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use async_trait::async_trait;
use futures_util::StreamExt;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Notify, Semaphore};

/// 先记录真实进入，再由测试放行；取消等待不产生随后补跑的任务。
pub struct Gate {
    entered: AtomicBool,
    changed: Notify,
    release: Semaphore,
}

impl Gate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: AtomicBool::new(false),
            changed: Notify::new(),
            release: Semaphore::new(0),
        })
    }

    pub async fn block(&self) {
        self.entered.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
        self.release
            .acquire()
            .await
            .expect("测试门闩未关闭")
            .forget();
    }

    pub async fn wait_entered(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.entered.load(Ordering::SeqCst) {
                return;
            }
            changed.await;
        }
    }

    pub fn open(&self) {
        self.release.add_permits(1);
    }
}

#[derive(Default)]
pub struct Delays {
    pub download: Option<Arc<Gate>>,
    pub stream: Option<Arc<Gate>>,
    pub put: Option<Arc<Gate>>,
}

/// 种子上传与结果下载直接走 inner，避免把基线计入被测调用。
pub struct ObservedStore {
    pub inner: Arc<FileArtifacts>,
    pub downloads: AtomicUsize,
    pub puts: AtomicUsize,
    pub published: AtomicUsize,
    delays: Delays,
}

impl ObservedStore {
    pub fn new(inner: Arc<FileArtifacts>, delays: Delays) -> Arc<Self> {
        Arc::new(Self {
            inner,
            downloads: AtomicUsize::new(0),
            puts: AtomicUsize::new(0),
            published: AtomicUsize::new(0),
            delays,
        })
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.downloads.load(Ordering::SeqCst),
            self.puts.load(Ordering::SeqCst),
            self.published.load(Ordering::SeqCst),
        )
    }
}

#[async_trait]
impl ArtifactStore for ObservedStore {
    async fn put(&self, filename: String, stream: ArtifactStream) -> Result<Artifact> {
        self.puts.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.delays.put {
            gate.block().await;
        }
        let artifact = self.inner.put(filename, stream).await?;
        self.published.fetch_add(1, Ordering::SeqCst);
        Ok(artifact)
    }

    async fn get(&self, id: &str) -> Result<Artifact> {
        self.inner.get(id).await
    }

    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.delays.download {
            gate.block().await;
        }
        let (artifact, stream) = self.inner.download(id).await?;
        let gate = self.delays.stream.clone();
        let stream =
            futures_util::stream::unfold((stream, gate), |(mut stream, gate)| async move {
                if let Some(gate) = gate {
                    gate.block().await;
                }
                stream.next().await.map(|chunk| (chunk, (stream, None)))
            });
        Ok((artifact, Box::pin(stream)))
    }

    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage> {
        self.inner.archive_entries(id, offset, limit).await
    }
}
