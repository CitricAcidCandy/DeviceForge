//! 包装真实产物存储，只在副本流首块和输出发布前注入可控等待。

use apk_domain::{
    Result,
    artifacts::{ArchivePage, Artifact, ArtifactStore, ArtifactStream},
};
use apk_infrastructure::artifacts::FileArtifacts;
use async_trait::async_trait;
use futures_util::{TryStreamExt, stream};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

pub struct Gate {
    entered: CancellationToken,
    released: CancellationToken,
    completed: AtomicUsize,
}

impl Gate {
    pub fn new(blocked: bool) -> Arc<Self> {
        let gate = Arc::new(Self {
            entered: CancellationToken::new(),
            released: CancellationToken::new(),
            completed: AtomicUsize::new(0),
        });
        if !blocked {
            gate.release();
        }
        gate
    }

    async fn wait(&self) {
        self.entered.cancel();
        self.released.cancelled().await;
        self.completed.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn entered(&self) {
        self.entered.cancelled().await;
    }

    pub fn release(&self) {
        self.released.cancel();
    }

    pub fn completions(&self) -> usize {
        self.completed.load(Ordering::SeqCst)
    }
}

pub struct ControlledStore {
    pub inner: Arc<FileArtifacts>,
    pub copying: Arc<Gate>,
    pub publishing: Arc<Gate>,
    gets: AtomicUsize,
    downloads: AtomicUsize,
    committed: AtomicUsize,
}

impl ControlledStore {
    pub fn new(inner: Arc<FileArtifacts>, copy_blocked: bool, publish_blocked: bool) -> Arc<Self> {
        Arc::new(Self {
            inner,
            copying: Gate::new(copy_blocked),
            publishing: Gate::new(publish_blocked),
            gets: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            committed: AtomicUsize::new(0),
        })
    }

    pub fn reads(&self) -> usize {
        self.gets.load(Ordering::SeqCst) + self.downloads.load(Ordering::SeqCst)
    }

    pub fn committed(&self) -> usize {
        self.committed.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl ArtifactStore for ControlledStore {
    async fn put(&self, filename: String, stream: ArtifactStream) -> Result<Artifact> {
        self.publishing.wait().await;
        let artifact = self.inner.put(filename, stream).await?;
        self.committed.fetch_add(1, Ordering::SeqCst);
        Ok(artifact)
    }

    async fn get(&self, id: &str) -> Result<Artifact> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(id).await
    }

    async fn download(&self, id: &str) -> Result<(Artifact, ArtifactStream)> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let (artifact, input) = self.inner.download(id).await?;
        let gate = self.copying.clone();
        // 等待发生在流被实际轮询时，不能用只延迟元数据查询冒充慢副本。
        let output = stream::try_unfold((input, Some(gate)), |(mut input, gate)| async move {
            if let Some(gate) = gate {
                gate.wait().await;
            }
            Ok::<_, apk_domain::Error>(input.try_next().await?.map(|chunk| (chunk, (input, None))))
        });
        Ok((artifact, Box::pin(output)))
    }

    async fn archive_entries(&self, id: &str, offset: usize, limit: usize) -> Result<ArchivePage> {
        self.inner.archive_entries(id, offset, limit).await
    }
}
