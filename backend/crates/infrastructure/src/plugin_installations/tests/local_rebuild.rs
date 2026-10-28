//! 离线同版本构建只允许同安装身份的 CAS 更新；市场与共享工具仍不可覆盖摘要。
use super::*;

fn unpack(bytes: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            (file.name().to_owned(), bytes)
        })
        .collect()
}

fn rebuild(tool: &[u8], build: &str) -> Vec<u8> {
    let mut files = unpack(release_bytes("1.0.0", tool, false));
    let component = files
        .iter_mut()
        .find(|(name, _)| name == "components/browser.zip")
        .unwrap();
    let mut contents = unpack(component.1.clone());
    contents
        .iter_mut()
        .find(|(name, _)| name == "dist/index.js")
        .unwrap()
        .1 = format!("export const build = '{build}';").into_bytes();
    component.1 = zip(contents
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.clone()))
        .collect());
    let digest = format!("{:x}", Sha256::digest(&component.1));
    let size = component.1.len();
    let manifest = files
        .iter_mut()
        .find(|(name, _)| name == "release.json")
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&manifest.1).unwrap();
    value["components"][0]["variants"][0]["sha256"] = digest.into();
    value["components"][0]["variants"][0]["size"] = size.into();
    manifest.1 = serde_json::to_vec(&value).unwrap();
    zip(files
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.clone()))
        .collect())
}

#[tokio::test]
async fn offline_same_version_cas_rebuild_keeps_successful_revision_restorable() {
    let (_directory, artifacts, store) = setup().await;
    let first = store
        .prepare(upload(&artifacts, rebuild(b"shared-tool", "first")).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    store
        .set_enabled(&first.id, &first.revision, true)
        .await
        .unwrap();
    store
        .record_successful_activation(&first.id, &first.revision)
        .await
        .unwrap();
    let source = upload(&artifacts, rebuild(b"shared-tool", "second")).await;
    let plan = store.plan(source.clone()).await.unwrap();
    assert!(
        !plan
            .issues
            .iter()
            .any(|issue| issue.code == "version_conflict")
    );
    let second = store
        .prepare(source)
        .await
        .unwrap()
        .commit(Some(first.revision.clone()))
        .await
        .unwrap();
    assert_eq!(second.version, first.version);
    assert_eq!(second.components[0].version, first.components[0].version);
    assert_ne!(second.revision, first.revision);
    let identity: prepare::ResourceIdentity = paths::read(
        &store
            .root
            .join("installations/identities/release/sample_release/1.0.0/all.json"),
        16 * 1024,
    )
    .unwrap();
    assert_eq!(identity.sha256, first.revision);
    for revision in [&first.revision, &second.revision] {
        let identity: prepare::ResourceIdentity = paths::read(
            &store.root.join(format!(
                "installations/build-identities/{}/{revision}/release/{}/1.0.0/all.json",
                first.id, first.id
            )),
            16 * 1024,
        )
        .unwrap();
        assert_eq!(&identity.sha256, revision);
    }
    let active = storage::component_root(&store.root, PackageKind::Browser, "sample_browser");
    for (revision, build) in [(&first.revision, "first"), (&second.revision, "second")] {
        let bytes = fs::read_to_string(
            active
                .join("revisions")
                .join(revision)
                .join("dist/index.js"),
        )
        .unwrap();
        assert!(bytes.contains(build));
    }
    store.cleanup_resources(false, vec![]).await.unwrap();
    let restored = store
        .restore_previous_successful(
            &second.id,
            &second.revision,
            &first.revision,
            Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(restored.revision, first.revision);
    assert!(restored.enabled);
}

#[tokio::test]
async fn offline_same_version_rebuild_requires_current_cas_and_keeps_tool_digest_locked() {
    let (_directory, artifacts, store) = setup().await;
    let first = store
        .prepare(upload(&artifacts, rebuild(b"shared-tool", "first")).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let source = upload(&artifacts, rebuild(b"shared-tool", "second")).await;
    for expected in [None, Some("f".repeat(64))] {
        assert!(matches!(
            store
                .prepare(source.clone())
                .await
                .unwrap()
                .commit(expected)
                .await,
            Err(Error::Conflict(_))
        ));
    }
    let changed_tool = upload(&artifacts, rebuild(b"changed-tool", "second")).await;
    assert!(
        store
            .plan(changed_tool.clone())
            .await
            .unwrap()
            .issues
            .iter()
            .any(|issue| issue.code == "version_conflict")
    );
    assert!(matches!(
        store.prepare(changed_tool).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(store.get(&first.id).await.unwrap().revision, first.revision);
    store.delete(&first.id, &first.revision).await.unwrap();
    // 删除后的全新安装没有同身份当前 CAS，不得借离线来源改写版本锁。
    assert!(matches!(
        store.prepare(source).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn market_same_version_rebuild_remains_digest_locked() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/catalog/", listener.local_addr().unwrap());
    let (_directory, artifacts, store) = setup_with_sources(vec![base.clone()]).await;
    let first = store
        .prepare(upload(&artifacts, rebuild(b"shared-tool", "first")).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let manifest = unpack(rebuild(b"shared-tool", "second"))
        .into_iter()
        .find(|(name, _)| name == "release.json")
        .unwrap()
        .1;
    let source = InstallSource::Market {
        source_url: format!("{base}release.json"),
        release_id: first.id.clone(),
        version: first.version.clone(),
        manifest_sha256: format!("{:x}", Sha256::digest(&manifest)),
    };
    let task = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 512];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0 && request.len() + count <= 4096);
                request.extend_from_slice(&buffer[..count]);
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        manifest.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(&manifest).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    let plan = store.plan(source.clone()).await;
    let prepared = store.prepare(source).await;
    task.await.unwrap();
    assert!(
        plan.unwrap()
            .issues
            .iter()
            .any(|issue| issue.code == "version_conflict")
    );
    assert!(matches!(prepared, Err(Error::Conflict(_))));
    assert_eq!(store.get(&first.id).await.unwrap().revision, first.revision);
}
