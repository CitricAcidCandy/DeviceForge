use super::{GuideService, GuideSource, GuideView, rules};
use apk_domain::{
    Error, Result,
    plugin_guides::{GuideDocument, GuideSnapshot, GuideStore, MAX_GUIDE_BYTES},
};
use async_trait::async_trait;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const TOPICS: [&str; 8] = [
    "overview",
    "manifest",
    "sdk",
    "lifecycle",
    "examples",
    "packaging",
    "dependencies",
    "validation",
];

fn snapshot(label: &str, version: u32) -> GuideSnapshot {
    let documents = ["frontend", "backend"]
        .into_iter()
        .flat_map(|target| {
            TOPICS.into_iter().map(move |topic| GuideDocument {
                target: target.into(),
                topic: topic.into(),
                content: format!(
                    "# {target}/{topic}\n{label}\n{}",
                    "公开开发指南。".repeat(30)
                ),
            })
        })
        .collect::<Vec<_>>();
    GuideSnapshot {
        format_version: 1,
        compatibility_version: 5,
        guide_version: version,
        content_sha256: rules::digest(&documents).unwrap(),
        documents,
    }
}

fn bytes(snapshot: &GuideSnapshot) -> Vec<u8> {
    serde_json::to_vec(snapshot).unwrap()
}

#[derive(Default)]
struct Barrier {
    entered: Notify,
    release: Notify,
}

enum Download {
    Bytes(Vec<u8>),
    Failure,
    Waiting(Arc<Barrier>, Vec<u8>),
}

#[derive(Default)]
struct MemoryStore {
    cache: Mutex<Option<Vec<u8>>>,
    downloads: Mutex<VecDeque<Download>>,
    save_barrier: Mutex<Option<Arc<Barrier>>>,
    fail_save: AtomicBool,
    loads: AtomicUsize,
    fetches: AtomicUsize,
    saves: AtomicUsize,
}

impl MemoryStore {
    fn queue(&self, download: Download) {
        self.downloads.lock().unwrap().push_back(download);
    }

    fn stored(&self) -> Option<Vec<u8>> {
        self.cache.lock().unwrap().clone()
    }
}

#[async_trait]
impl GuideStore for MemoryStore {
    async fn load(&self, _: Instant, _: CancellationToken) -> Result<Option<Vec<u8>>> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        Ok(self.stored())
    }

    async fn download(&self, _: Instant, _: CancellationToken) -> Result<Vec<u8>> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        let next = self.downloads.lock().unwrap().pop_front();
        match next {
            Some(Download::Bytes(body)) => Ok(body),
            Some(Download::Waiting(barrier, body)) => {
                // 上游故意忽略取消，验证应用自己的等待边界。
                barrier.entered.notify_one();
                barrier.release.notified().await;
                Ok(body)
            }
            Some(Download::Failure) | None => Err(Error::Dependency("内存下载失败".into())),
        }
    }

    async fn save(&self, body: Vec<u8>, _: Instant, _: CancellationToken) -> Result<()> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        let barrier = self.save_barrier.lock().unwrap().clone();
        if let Some(barrier) = barrier {
            barrier.entered.notify_one();
            barrier.release.notified().await;
        }
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(Error::Storage("内存保存失败".into()));
        }
        *self.cache.lock().unwrap() = Some(body);
        Ok(())
    }
}

fn service(store: Arc<MemoryStore>, shutdown: CancellationToken) -> Arc<GuideService> {
    GuideService::new(snapshot("内置正文", 5), Some(store), shutdown).unwrap()
}

fn spawn_update(service: &Arc<GuideService>) -> tokio::task::JoinHandle<Result<GuideView>> {
    let service = service.clone();
    tokio::spawn(async move { service.update().await })
}

#[tokio::test]
async fn reads_use_embedded_or_verified_cache_without_download_or_save() {
    for cached in [false, true] {
        let store = Arc::new(MemoryStore::default());
        let expected = if cached {
            let expected = snapshot("已保存正文", 6);
            *store.cache.lock().unwrap() = Some(bytes(&expected));
            expected
        } else {
            snapshot("内置正文", 5)
        };
        let guides = service(store.clone(), CancellationToken::new());
        for _ in 0..2 {
            let view = guides.read().await;
            assert_eq!(view.snapshot.as_ref(), &expected);
            assert_eq!(
                view.source,
                if cached {
                    GuideSource::Cached
                } else {
                    GuideSource::Embedded
                }
            );
        }
        assert_eq!(store.loads.load(Ordering::SeqCst), 1);
        assert_eq!(store.fetches.load(Ordering::SeqCst), 0);
        assert_eq!(store.saves.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn update_switches_only_after_the_complete_snapshot_is_saved() {
    let store = Arc::new(MemoryStore::default());
    let expected = snapshot("在线新版", 6);
    store.queue(Download::Bytes(bytes(&expected)));
    let barrier = Arc::new(Barrier::default());
    *store.save_barrier.lock().unwrap() = Some(barrier.clone());
    let guides = service(store.clone(), CancellationToken::new());
    let pending = spawn_update(&guides);
    barrier.entered.notified().await;

    let during_save = guides.read().await;
    assert_eq!(during_save.source, GuideSource::Embedded);
    assert_eq!(during_save.snapshot.guide_version, 5);
    assert!(store.stored().is_none());

    barrier.release.notify_one();
    let applied = pending.await.unwrap().unwrap();
    assert_eq!(applied.source, GuideSource::Online);
    assert_eq!(applied.snapshot.as_ref(), &expected);
    assert_eq!(guides.read().await.snapshot.as_ref(), &expected);
    assert_eq!(store.stored(), Some(bytes(&expected)));
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_download_or_save_keeps_the_current_guide_and_allows_a_new_update() {
    let store = Arc::new(MemoryStore::default());
    let previous = snapshot("先前在线正文", 6);
    store.queue(Download::Bytes(bytes(&previous)));
    let guides = service(store.clone(), CancellationToken::new());
    guides.update().await.unwrap();

    store.queue(Download::Failure);
    assert!(guides.update().await.is_err());
    assert_eq!(guides.read().await.snapshot.as_ref(), &previous);
    assert_eq!(store.stored(), Some(bytes(&previous)));

    let expected = snapshot("独立新更新", 7);
    store.fail_save.store(true, Ordering::SeqCst);
    store.queue(Download::Bytes(bytes(&expected)));
    assert!(guides.update().await.is_err());
    assert_eq!(guides.read().await.snapshot.as_ref(), &previous);
    assert_eq!(store.stored(), Some(bytes(&previous)));

    store.fail_save.store(false, Ordering::SeqCst);
    store.queue(Download::Bytes(bytes(&expected)));
    let applied = guides.update().await.unwrap();
    assert_eq!(applied.snapshot.as_ref(), &expected);
    assert_eq!(store.stored(), Some(bytes(&expected)));
    assert!(!applied.diagnostics.is_empty(), "新成功不抹去此前更新诊断");
}

#[tokio::test]
async fn invalid_cache_falls_back_without_blocking_an_independent_online_update() {
    let store = Arc::new(MemoryStore::default());
    let invalid_cache = b"{not a guide}".to_vec();
    *store.cache.lock().unwrap() = Some(invalid_cache.clone());
    let guides = service(store.clone(), CancellationToken::new());
    let fallback = guides.read().await;
    assert_eq!(fallback.source, GuideSource::Embedded);
    assert_eq!(fallback.snapshot.as_ref(), &snapshot("内置正文", 5));
    assert!(!fallback.diagnostics.is_empty());
    assert_eq!(store.stored(), Some(invalid_cache));
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);

    let expected = snapshot("完整修订", 6);
    store.queue(Download::Bytes(bytes(&expected)));
    let applied = guides.update().await.unwrap();
    assert_eq!(applied.snapshot.as_ref(), &expected);
    assert_eq!(store.stored(), Some(bytes(&expected)));
}

#[tokio::test]
async fn incompatible_incomplete_duplicate_tampered_and_oversized_snapshots_never_apply() {
    let original = snapshot("校验目标", 6);
    let mut cases = Vec::new();
    let mutators: [fn(&mut GuideSnapshot); 7] = [
        |item| item.format_version = 2,
        |item| item.compatibility_version = 6,
        |item| item.guide_version = 4,
        |item| item.documents[1] = item.documents[0].clone(),
        |item| {
            item.documents.pop();
        },
        |item| item.documents[0].topic = "unknown".into(),
        |item| item.documents[0].content = "x".repeat(131_073),
    ];
    for mutate in mutators {
        let mut invalid = original.clone();
        mutate(&mut invalid);
        invalid.content_sha256 = rules::digest(&invalid.documents).unwrap();
        cases.push(bytes(&invalid));
    }
    let mut tampered = original.clone();
    tampered.documents[0].content.push_str("内容已变但摘要未变");
    cases.push(bytes(&tampered));
    cases.push(vec![b' '; MAX_GUIDE_BYTES + 1]);

    let store = Arc::new(MemoryStore::default());
    let guides = service(store.clone(), CancellationToken::new());
    for body in cases {
        store.queue(Download::Bytes(body));
        assert!(guides.update().await.is_err());
        assert_eq!(
            guides.read().await.snapshot.as_ref(),
            &snapshot("内置正文", 5)
        );
        assert!(store.stored().is_none());
    }
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
    store.queue(Download::Bytes(bytes(&original)));
    assert_eq!(guides.update().await.unwrap().snapshot.as_ref(), &original);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_update_is_rejected_without_blocking_reads_of_the_current_snapshot() {
    let store = Arc::new(MemoryStore::default());
    let expected = snapshot("在途新正文", 6);
    let barrier = Arc::new(Barrier::default());
    store.queue(Download::Waiting(barrier.clone(), bytes(&expected)));
    let guides = service(store.clone(), CancellationToken::new());
    let pending = spawn_update(&guides);
    barrier.entered.notified().await;

    let second = tokio::time::timeout(Duration::from_millis(200), guides.update())
        .await
        .expect("并发更新必须立即报告冲突，不排无界队列");
    assert!(matches!(second, Err(Error::Conflict(_))));
    let current = tokio::time::timeout(Duration::from_millis(200), guides.read())
        .await
        .expect("普通查询不等待在途网络更新");
    assert_eq!(current.snapshot.guide_version, 5);
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);

    barrier.release.notify_one();
    assert_eq!(pending.await.unwrap().unwrap().snapshot.as_ref(), &expected);
}

#[tokio::test(start_paused = true)]
async fn ignored_upstream_cancellation_is_still_bounded_by_shutdown_and_deadline() {
    for shutdown_first in [true, false] {
        let store = Arc::new(MemoryStore::default());
        let barrier = Arc::new(Barrier::default());
        store.queue(Download::Waiting(
            barrier.clone(),
            bytes(&snapshot("未确认新版", 6)),
        ));
        let shutdown = CancellationToken::new();
        let guides = service(store.clone(), shutdown.clone());
        let pending = spawn_update(&guides);
        barrier.entered.notified().await;

        if shutdown_first {
            shutdown.cancel();
        } else {
            // 虚拟时间推进，不让永不返回的上游拖住测试进程。
            tokio::time::advance(Duration::from_secs(60)).await;
        }
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("应用必须自行结束对忽略取消上游的等待")
            .unwrap();
        if shutdown_first {
            assert!(matches!(result, Err(Error::Cancelled)));
        } else {
            assert!(matches!(result, Err(Error::Timeout)));
        }
        assert_eq!(store.saves.load(Ordering::SeqCst), 0);
        assert!(store.stored().is_none());
        assert_eq!(guides.read().await.snapshot.guide_version, 5);
    }
}

#[tokio::test]
async fn reset_uses_the_embedded_snapshot_without_network_and_waits_for_save_confirmation() {
    let store = Arc::new(MemoryStore::default());
    let online = snapshot("在线正文", 6);
    store.queue(Download::Bytes(bytes(&online)));
    let guides = service(store.clone(), CancellationToken::new());
    guides.update().await.unwrap();

    store.fail_save.store(true, Ordering::SeqCst);
    assert!(guides.reset().await.is_err());
    assert_eq!(guides.read().await.snapshot.as_ref(), &online);
    assert_eq!(store.stored(), Some(bytes(&online)));

    store.fail_save.store(false, Ordering::SeqCst);
    let barrier = Arc::new(Barrier::default());
    *store.save_barrier.lock().unwrap() = Some(barrier.clone());
    let resetting = {
        let guides = guides.clone();
        tokio::spawn(async move { guides.reset().await })
    };
    barrier.entered.notified().await;
    assert_eq!(guides.read().await.snapshot.as_ref(), &online);
    assert_eq!(store.stored(), Some(bytes(&online)));

    barrier.release.notify_one();
    let reset = resetting.await.unwrap().unwrap();
    let builtin = snapshot("内置正文", 5);
    assert_eq!(reset.source, GuideSource::Embedded);
    assert_eq!(reset.snapshot.as_ref(), &builtin);
    assert_eq!(store.stored(), Some(bytes(&builtin)));
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn uncertain_save_is_visible_to_the_caller_without_replay() {
    let store = Arc::new(MemoryStore::default());
    let online = snapshot("等待保存的正文", 6);
    store.queue(Download::Bytes(bytes(&online)));
    let barrier = Arc::new(Barrier::default());
    *store.save_barrier.lock().unwrap() = Some(barrier.clone());
    let guides = service(store.clone(), CancellationToken::new());
    let pending = spawn_update(&guides);
    barrier.entered.notified().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    let error = pending
        .await
        .unwrap()
        .err()
        .expect("保存未确认不能冒充成功");
    assert!(matches!(&error, Error::Conflict(message) if message.contains("提交结果未确认")));
    assert_eq!(guides.read().await.snapshot.guide_version, 5);
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);

    assert!(store.stored().is_none());
}
