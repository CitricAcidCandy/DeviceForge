use super::{TOOL_NAME, UPDATE_TOOL_NAME, catalog, current, query, schema::TOPICS, update};
use apk_application::plugin_guides::GuideService;
use apk_domain::{
    Error, Result,
    plugin_guides::{GuideSnapshot, GuideStore, MAX_GUIDE_BYTES},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct MemoryStore {
    bytes: Mutex<Option<Vec<u8>>>,
    downloads: Mutex<VecDeque<Vec<u8>>>,
    loads: AtomicUsize,
    fetches: AtomicUsize,
    saves: AtomicUsize,
}

#[async_trait]
impl GuideStore for MemoryStore {
    async fn load(&self, _: Instant, _: CancellationToken) -> Result<Option<Vec<u8>>> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        Ok(self.bytes.lock().unwrap().clone())
    }

    async fn download(&self, _: Instant, _: CancellationToken) -> Result<Vec<u8>> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        self.downloads
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| Error::Dependency("没有登记内存指南下载".into()))
    }

    async fn save(&self, bytes: Vec<u8>, _: Instant, _: CancellationToken) -> Result<()> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        *self.bytes.lock().unwrap() = Some(bytes);
        Ok(())
    }
}

fn service(store: Arc<MemoryStore>) -> Arc<GuideService> {
    GuideService::new(
        catalog::builtin().unwrap(),
        Some(store),
        CancellationToken::new(),
    )
    .unwrap()
}

fn assert_document_shape(response: &Value, expected_count: usize) {
    let documents = response["documents"].as_array().unwrap();
    assert_eq!(documents.len(), expected_count);
    for document in documents {
        let fields = document.as_object().unwrap();
        assert_eq!(fields.len(), 3);
        for field in ["target", "topic", "content"] {
            assert!(fields.contains_key(field));
        }
        assert!(!document["content"].as_str().unwrap().trim().is_empty());
    }
}

#[tokio::test]
async fn current_preserves_three_targets_and_eight_topics_without_network_or_document_metadata() {
    let store = Arc::new(MemoryStore::default());
    let guides = service(store.clone());
    let builtin = catalog::builtin().unwrap();
    for topic in TOPICS {
        for (target, count) in [("frontend", 1), ("backend", 1), ("fullstack", 2)] {
            let input = json!({"target":target,"topic":topic});
            let legacy = query::get(input.clone()).unwrap();
            let observed = current(input, &guides).await.unwrap();
            for (key, value) in legacy.as_object().unwrap() {
                assert_eq!(&observed[key], value, "旧查询字段{key}必须兼容");
            }
            assert_document_shape(&observed, count);
            assert_eq!(observed["guide_source"], "embedded");
            assert_eq!(observed["guide_revision"], builtin.content_sha256);
            assert_eq!(
                observed["guide_compatibility_version"],
                builtin.guide_version
            );
            assert_eq!(observed["guide_diagnostics"], json!([]));
        }
    }
    let default_topic = current(json!({"target":"backend"}), &guides).await.unwrap();
    assert_eq!(default_topic["topic"], "overview");
    assert_eq!(store.loads.load(Ordering::SeqCst), 1);
    assert_eq!(store.fetches.load(Ordering::SeqCst), 0);
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_current_and_update_arguments_are_rejected_before_any_store_access() {
    let store = Arc::new(MemoryStore::default());
    let guides = service(store.clone());
    for invalid in [
        json!({}),
        json!(null),
        json!([]),
        json!({"target":null}),
        json!({"target":1}),
        json!({"target":"other"}),
        json!({"target":"frontend","topic":null}),
        json!({"target":"frontend","topic":true}),
        json!({"target":"backend","topic":"other"}),
        json!({"target":"backend","path":"guide.md"}),
        json!({"target":"frontend","refresh":true}),
    ] {
        assert!(matches!(
            query::get(invalid.clone()),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            current(invalid, &guides).await,
            Err(Error::Invalid(_))
        ));
    }
    for invalid in [
        json!({}),
        json!(null),
        json!([]),
        json!("update"),
        json!({"action":null}),
        json!({"action":1}),
        json!({"action":"check"}),
        json!({"action":"UPDATE"}),
        json!({"action":"update","url":"https://example.invalid/guide.json"}),
        json!({"action":"reset","target":"frontend"}),
    ] {
        assert!(matches!(
            update(invalid, &guides).await,
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(store.loads.load(Ordering::SeqCst), 0);
    assert_eq!(store.fetches.load(Ordering::SeqCst), 0);
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn update_boundary_adopts_new_text_and_reset_returns_to_embedded_without_download() {
    let store = Arc::new(MemoryStore::default());
    let guides = service(store.clone());
    let builtin = catalog::builtin().unwrap();
    let mut documents = builtin.documents.clone();
    for document in &mut documents {
        document.content.push_str("\n\n本次内存指南修订已采用。\n");
    }
    let online =
        apk_application::plugin_guides::embedded(documents, builtin.guide_version).unwrap();
    store
        .downloads
        .lock()
        .unwrap()
        .push_back(serde_json::to_vec(&online).unwrap());

    let applied = update(json!({"action":"update"}), &guides).await.unwrap();
    assert_eq!(applied["guide_source"], "online");
    assert_eq!(applied["guide_revision"], online.content_sha256);
    assert!(applied.get("documents").is_none());
    let response = current(json!({"target":"fullstack","topic":"sdk"}), &guides)
        .await
        .unwrap();
    assert_document_shape(&response, 2);
    for document in response["documents"].as_array().unwrap() {
        assert!(
            document["content"]
                .as_str()
                .unwrap()
                .ends_with("本次内存指南修订已采用。\n")
        );
    }
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);

    let reset = update(json!({"action":"reset"}), &guides).await.unwrap();
    assert_eq!(reset["guide_source"], "embedded");
    assert_eq!(reset["guide_revision"], builtin.content_sha256);
    let restored = current(json!({"target":"fullstack","topic":"sdk"}), &guides)
        .await
        .unwrap();
    assert_eq!(
        restored["documents"],
        query::get(json!({"target":"fullstack","topic":"sdk"})).unwrap()["documents"]
    );
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 2);
    let cached: GuideSnapshot =
        serde_json::from_slice(store.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(cached, builtin);
}

#[test]
fn tool_directory_keeps_read_and_update_discoverable_without_plugin_management() {
    let tools = crate::mcp_tools::management_tools(false);
    for (name, read_only) in [(TOOL_NAME, true), (UPDATE_TOOL_NAME, false)] {
        let matching = tools
            .iter()
            .filter(|tool| tool.name.as_ref() == name)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1, "两个指南入口都必须可发现且不得重复");
        let tool = serde_json::to_value(matching[0]).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], read_only);
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
}

#[tokio::test]
async fn explicit_snapshot_fixture_passes_the_same_runtime_digest_and_topic_validation() {
    let body = match std::env::var_os("DEVICEFORGE_GUIDE_SNAPSHOT_FIXTURE") {
        Some(path) => {
            let metadata = std::fs::metadata(&path).expect("显式指南快照夹具必须可读取");
            assert!(metadata.len() <= MAX_GUIDE_BYTES as u64);
            std::fs::read(path).expect("显式指南快照读取失败，不回退其他仓库")
        }
        // 未显式指定时只用内置等价快照，不搜索相邻仓库或本机私有目录。
        None => serde_json::to_vec(&catalog::builtin().unwrap()).unwrap(),
    };
    let expected: GuideSnapshot = serde_json::from_slice(&body).unwrap();
    let store = Arc::new(MemoryStore::default());
    store.downloads.lock().unwrap().push_back(body);
    let guides = service(store.clone());
    let applied = update(json!({"action":"update"}), &guides).await.unwrap();
    assert_eq!(applied["guide_revision"], expected.content_sha256);
    assert_eq!(applied["guide_source"], "online");

    for topic in TOPICS {
        let response = current(json!({"target":"fullstack","topic":topic}), &guides)
            .await
            .unwrap();
        assert_document_shape(&response, 2);
        for document in response["documents"].as_array().unwrap() {
            let original = expected
                .documents
                .iter()
                .find(|candidate| {
                    candidate.target == document["target"].as_str().unwrap()
                        && candidate.topic == document["topic"].as_str().unwrap()
                })
                .unwrap();
            assert_eq!(document["content"], original.content);
        }
    }
    assert_eq!(store.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
}
