use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

async fn response(status: &str, bytes: &[u8]) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let body = bytes.to_vec();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 8192];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.write_all(header.as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
    });
    (format!("http://{address}/tool"), task)
}

fn source(url: String, bytes: &[u8]) -> DependencySource {
    DependencySource {
        kind: SourceKind::Market,
        url,
        platform: Repository::platform(),
        version: "1.2.3".into(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: bytes.len() as u64,
        format: ArchiveFormat::File,
        entries: BTreeMap::from([("program".into(), "bin/tool".into())]),
    }
}

#[tokio::test]
async fn resource_unavailable_can_fallback_but_digest_mismatch_is_fatal() {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = b"verified-tool";
    let (url, server) = response("404 Not Found", b"").await;
    let result = fetch(
        &client_builder().no_proxy().build().unwrap(),
        &source(url, bytes),
        &temporary.path().join("missing"),
        &CancellationToken::new(),
        Instant::now() + Duration::from_secs(10),
    )
    .await;
    assert!(matches!(result, Err(AttemptError::Fallback(_))));
    server.await.unwrap();
    let (url, server) = response("200 OK", bytes).await;
    let mut wrong = source(url, bytes);
    wrong.sha256 = "0".repeat(64);
    let result = fetch(
        &client_builder().no_proxy().build().unwrap(),
        &wrong,
        &temporary.path().join("digest"),
        &CancellationToken::new(),
        Instant::now() + Duration::from_secs(10),
    )
    .await;
    assert!(matches!(
        result,
        Err(AttemptError::Fatal(Error::Dependency(_)))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn publish_is_pinned_before_binding_and_only_preparation_reference_is_released() {
    let (_temporary, store) = super::super::tests::fixture().await;
    let bytes = b"verified-tool";
    let (url, server) = response("200 OK", bytes).await;
    let mut definition = super::super::tests::dependency("^1");
    definition.sources = vec![source(url, bytes)];
    let mut preparation = Preparation::new();
    let selection = store
        .download_dependency(
            &definition,
            &mut preparation,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(10),
        )
        .await
        .unwrap();
    server.await.unwrap();
    let key = selection.key.unwrap();
    let writer = store.repository.write().unwrap();
    assert_eq!(
        writer.references(&key).unwrap(),
        vec![preparation.owner.clone()]
    );
    assert!(matches!(
        writer.remove(&key, &|| Ok(())),
        Err(deviceforge_tool_repository::Error::InUse)
    ));
    drop(writer);
    store.release_preparation(preparation).await;
    let writer = store.repository.write().unwrap();
    assert!(writer.references(&key).unwrap().is_empty());
    assert!(store.repository.path(&key).unwrap().is_dir());
}

#[tokio::test]
async fn cancelled_download_does_not_publish_or_register_references() {
    let (_temporary, store) = super::super::tests::fixture().await;
    let mut definition = super::super::tests::dependency("^1");
    definition.sources = vec![source("http://127.0.0.1:1/tool".into(), b"tool")];
    let mut preparation = Preparation::new();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        store
            .download_dependency(
                &definition,
                &mut preparation,
                cancel,
                Instant::now() + Duration::from_secs(10)
            )
            .await,
        Err(Error::Cancelled)
    ));
    assert!(preparation.keys.is_empty());
    assert!(
        store
            .repository
            .read()
            .unwrap()
            .tool_index(&|| Ok(()))
            .unwrap()
            .tools
            .is_empty()
    );
}

#[test]
fn redirects_are_bounded_https_only_and_do_not_accept_credentials_or_fragments() {
    let safe = reqwest::Url::parse("https://cdn.example.test/archive").unwrap();
    assert!(redirect_allowed(&safe, 1));
    assert!(redirect_allowed(&safe, 4));
    assert!(!redirect_allowed(&safe, 5));
    for url in [
        "http://cdn.example.test/archive",
        "https://name@cdn.example.test/archive",
        "https://cdn.example.test/archive#part",
    ] {
        assert!(!redirect_allowed(&reqwest::Url::parse(url).unwrap(), 1));
    }
}

#[tokio::test]
async fn found_main_tool_with_no_source_only_downloads_missing_prerequisite() {
    let (_temporary, store) = super::super::tests::fixture().await;
    let local = store.root.join("main-tool");
    std::fs::write(&local, b"already-found").unwrap();
    let mut main = super::super::tests::dependency("*");
    main.requires.push("prerequisite".into());
    main.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "main-tool".into(),
        entries: BTreeMap::from([("program".into(), ".".into())]),
    });
    let (url, server) = response("200 OK", b"prerequisite-tool").await;
    let mut prerequisite = super::super::tests::dependency("^1");
    prerequisite.id = "prerequisite".into();
    prerequisite.required = false;
    prerequisite.bindings.clear();
    prerequisite.sources.push(source(url, b"prerequisite-tool"));
    let target = super::super::tests::deploy(
        &store,
        "only-missing-prerequisite",
        vec![main, prerequisite],
    );
    let installed = super::super::tests::install(&store, target).await.unwrap();
    server.await.unwrap();
    assert!(installed.ready);
    assert_eq!(
        installed.dependencies[0].source,
        Some(DependencyOrigin::Local)
    );
    assert_eq!(
        installed.dependencies[1].source,
        Some(DependencyOrigin::Shared)
    );
    assert_eq!(std::fs::read(local).unwrap(), b"already-found");
    let index = store
        .repository
        .read()
        .unwrap()
        .tool_index(&|| Ok(()))
        .unwrap();
    assert_eq!(index.tools.len(), 1);
    assert_eq!(index.tools[0].key.id, "prerequisite");
}

#[tokio::test]
async fn later_failure_keeps_old_binding_and_leaves_new_download_explicitly_unreferenced() {
    let (_temporary, store) = super::super::tests::fixture().await;
    let old_key = super::super::tests::publish(&store, "1.2.3", 'a');
    let target = super::super::tests::deploy(
        &store,
        "later-failure",
        vec![super::super::tests::dependency("^1")],
    );
    super::super::tests::install(&store, target.clone())
        .await
        .unwrap();
    let previous = std::fs::read(super::super::state::path(&store.root, &target)).unwrap();
    let (url, server) = response("200 OK", b"new-version").await;
    let mut upgraded = super::super::tests::dependency("^2");
    let mut download = source(url, b"new-version");
    download.version = "2.0.0".into();
    upgraded.sources.push(download);
    let mut missing = super::super::tests::dependency("^1");
    missing.id = "missing-after-download".into();
    missing.bindings.clear();
    super::super::tests::deploy(&store, &target.id, vec![upgraded, missing]);
    assert!(
        super::super::tests::install(&store, target.clone())
            .await
            .is_err()
    );
    server.await.unwrap();
    assert_eq!(
        std::fs::read(super::super::state::path(&store.root, &target)).unwrap(),
        previous
    );
    let tools = store
        .repository
        .read()
        .unwrap()
        .tool_index(&|| Ok(()))
        .unwrap();
    assert_eq!(tools.tools.len(), 2);
    let new_key = &tools
        .tools
        .iter()
        .find(|tool| tool.runtime_version == "2.0.0")
        .unwrap()
        .key;
    let writer = store.repository.write().unwrap();
    assert_eq!(writer.references(&old_key).unwrap().len(), 1);
    assert!(writer.references(new_key).unwrap().is_empty());
}
