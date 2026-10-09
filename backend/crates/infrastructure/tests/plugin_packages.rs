use apk_domain::{Error, Executor, artifacts::ArtifactStream, plugin_packages::*};
use apk_infrastructure::{plugin_packages::FilePluginPackages, plugins::ProcessPlugin};
use futures_util::{TryStreamExt, stream};
use serde_json::json;
use std::{
    io::{Cursor, Write},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

fn body(bytes: Vec<u8>) -> ArtifactStream {
    Box::pin(stream::once(async move { Ok(bytes.into()) }))
}
fn browser_files() -> Vec<(String, Vec<u8>)> {
    vec![
        ("package.json".into(),serde_json::to_vec(&json!({"version":"1.0.0","scripts":{"install":"不得执行"},"deviceforge":{"kind":"browser","manifest":"browser.json","entrypoints":{"any":{"runtime":"browser","path":"dist/entry.js"}}}})).unwrap()),
        ("browser.json".into(),br#"{"id":"webdemo","version":"1.0.0","api_version":2}"#.to_vec()),
        ("dist/entry.js".into(),b"import './child.js'; export default {};".to_vec()),
        ("dist/child.js".into(),b"export const child = true;".to_vec()),
        ("dist/data.json".into(),br#"{"original":true}"#.to_vec()),
    ]
}
fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap().into_inner()
}
fn tgz(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(gzip);
    for (name, bytes) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, format!("package/{name}"), bytes.as_slice())
            .unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}
async fn store() -> (tempfile::TempDir, Arc<FilePluginPackages>) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        FilePluginPackages::open(
            &directory.path().join("server"),
            &directory.path().join("browser"),
            None,
        )
        .await
        .unwrap(),
    );
    (directory, store)
}

#[tokio::test]
async fn portable_devices_are_preserved_and_bad_manifest_is_invalid_input(){
    let (directory,store)=store().await;
    let mut manifest:serde_json::Value=serde_json::from_slice(include_bytes!("../../../examples/device-provider-node/plugin.json")).unwrap();
    let package=json!({"version":"0.1.0","deviceforge":{"kind":"server","manifest":"plugin.json","entrypoints":{"any":{"runtime":"node","path":"index.mjs"}}}});
    let files=vec![("package.json".into(),serde_json::to_vec(&package).unwrap()),("plugin.json".into(),serde_json::to_vec(&manifest).unwrap()),("index.mjs".into(),include_bytes!("../../../examples/device-provider-node/index.mjs").to_vec())];
    store.prepare(PackageKind::Server,PackageFormat::Tgz,body(tgz(&files))).await.unwrap().commit().await.unwrap();
    let saved:apk_plugin_sdk::Manifest=serde_json::from_slice(&std::fs::read(directory.path().join("server/device_node_example/manifest.json")).unwrap()).unwrap();
    assert_eq!(saved.devices.unwrap().capabilities.len(),2);
    manifest["devices"]["api_version"]=json!(99);
    let mut bad=files.clone();bad[1].1=serde_json::to_vec(&manifest).unwrap();
    assert!(matches!(store.prepare(PackageKind::Server,PackageFormat::Tgz,body(tgz(&bad))).await,Err(Error::Invalid(_))));
    manifest["devices"]["api_version"]=json!(1);
    manifest["operations"][1]["name"]=json!("discover");
    bad[1].1=serde_json::to_vec(&manifest).unwrap();
    assert!(matches!(store.prepare(PackageKind::Server,PackageFormat::Tgz,body(tgz(&bad))).await,Err(Error::Invalid(_))));
}

#[tokio::test]
async fn zip_and_npm_tgz_install_read_relative_resources_conflict_and_delete() {
    for format in [PackageFormat::Zip, PackageFormat::Tgz] {
        let (_directory, store) = store().await;
        let bytes = match format {
            PackageFormat::Zip => zip(&browser_files()),
            PackageFormat::Tgz => tgz(&browser_files()),
        };
        let prepared = store
            .prepare(PackageKind::Browser, format, body(bytes.clone()))
            .await
            .unwrap();
        assert!(store.list(PackageKind::Browser).await.unwrap().is_empty());
        let info = prepared.commit().await.unwrap();
        assert_eq!(info.entry_path, "dist/entry.js");
        assert_eq!(info.api_version, Some(2));
        assert_eq!(
            info.entry_url.as_deref(),
            Some("/api/v2/browser-plugins/webdemo/assets/dist/entry.js")
        );
        assert_eq!(store.list(PackageKind::Browser).await.unwrap().len(), 1);
        let asset = store.asset("webdemo", "dist/data.json").await.unwrap();
        assert_eq!(asset.content_type, "application/json");
        let bytes = asset
            .stream
            .try_fold(Vec::new(), |mut bytes, chunk| async move {
                bytes.extend_from_slice(&chunk);
                Ok(bytes)
            })
            .await
            .unwrap();
        assert_eq!(bytes, br#"{"original":true}"#);
        let prepared = store
            .prepare(
                PackageKind::Browser,
                format,
                body(match format {
                    PackageFormat::Zip => zip(&browser_files()),
                    PackageFormat::Tgz => tgz(&browser_files()),
                }),
            )
            .await
            .unwrap();
        assert!(matches!(prepared.commit().await, Err(Error::Conflict(_))));
        assert_eq!(
            store
                .delete(PackageKind::Browser, "webdemo")
                .await
                .unwrap()
                .id,
            "webdemo"
        );
        assert!(store.list(PackageKind::Browser).await.unwrap().is_empty());
        assert!(matches!(
            store.asset("webdemo", "dist/entry.js").await,
            Err(Error::NotFound(_))
        ));
    }
}

#[tokio::test]
async fn invalid_archive_paths_duplicates_versions_and_formats_never_publish() {
    let (_directory, store) = store().await;
    for name in [
        "../escape.js",
        "/absolute.js",
        "C:/escape.js",
        "a\\b.js",
        "dist/CON.js",
        "dist/CHILD.js",
    ] {
        let mut files = browser_files();
        files.push((name.into(), b"invalid".to_vec()));
        assert!(
            store
                .prepare(PackageKind::Browser, PackageFormat::Zip, body(zip(&files)))
                .await
                .is_err(),
            "应拒绝 {name}"
        );
    }
    for manifest in [
        br#"{"id":"webdemo","version":"2.0.0","api_version":2}"#.as_slice(),
        br#"{"id":"webdemo","version":"1.0.0","api_version":1}"#.as_slice(),
    ] {
        let mut files = browser_files();
        files[1].1 = manifest.to_vec();
        assert!(
            store
                .prepare(PackageKind::Browser, PackageFormat::Zip, body(zip(&files)))
                .await
                .is_err()
        );
    }
    assert!(
        store
            .prepare(
                PackageKind::Server,
                PackageFormat::Zip,
                body(zip(&browser_files()))
            )
            .await
            .is_err()
    );
    assert!(
        store
            .prepare(
                PackageKind::Browser,
                PackageFormat::Tgz,
                body(zip(&browser_files()))
            )
            .await
            .is_err()
    );
    assert!(store.list(PackageKind::Browser).await.unwrap().is_empty());
}

#[tokio::test]
async fn archive_symlinks_and_bad_resource_paths_are_rejected() {
    let (_directory, store) = store().await;
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .add_symlink(
            "link.js",
            "../escape",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    assert!(
        store
            .prepare(
                PackageKind::Browser,
                PackageFormat::Zip,
                body(archive.finish().unwrap().into_inner())
            )
            .await
            .is_err()
    );
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(gzip);
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_cksum();
    archive
        .append_link(&mut header, "package/link.js", "../escape")
        .unwrap();
    assert!(
        store
            .prepare(
                PackageKind::Browser,
                PackageFormat::Tgz,
                body(archive.into_inner().unwrap().finish().unwrap())
            )
            .await
            .is_err()
    );
    store
        .prepare(
            PackageKind::Browser,
            PackageFormat::Zip,
            body(zip(&browser_files())),
        )
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    for path in [
        "../package.json",
        "dist/../child.js",
        "dist\\entry.js",
        ".deviceforge-package.json",
        "/dist/entry.js",
    ] {
        assert!(store.asset("webdemo", path).await.is_err());
    }
}

#[tokio::test]
async fn upload_limits_cancelled_streams_and_reader_slots_stay_bounded() {
    let (directory, store) = store().await;
    let blocked = || Box::pin(stream::pending()) as ArtifactStream;
    let first = {
        let store = store.clone();
        tokio::spawn(async move {
            store
                .prepare(PackageKind::Browser, PackageFormat::Zip, blocked())
                .await
        })
    };
    let second = {
        let store = store.clone();
        tokio::spawn(async move {
            store
                .prepare(PackageKind::Browser, PackageFormat::Zip, blocked())
                .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let mut entries = tokio::fs::read_dir(directory.path().join("browser"))
                .await
                .unwrap();
            let mut count = 0;
            while let Some(entry) = entries.next_entry().await.unwrap() {
                if entry.file_name().to_string_lossy().starts_with(".package-") {
                    count += 1;
                }
            }
            if count == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        store
            .prepare(PackageKind::Browser, PackageFormat::Zip, body(vec![]))
            .await,
        Err(Error::Conflict(_))
    ));
    first.abort();
    second.abort();
    let _ = first.await;
    let _ = second.await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let mut entries = tokio::fs::read_dir(directory.path().join("browser"))
                .await
                .unwrap();
            let mut count = 0;
            while let Some(entry) = entries.next_entry().await.unwrap() {
                if entry.file_name().to_string_lossy().starts_with(".package-") {
                    count += 1;
                }
            }
            if count == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let large: ArtifactStream = Box::pin(stream::iter(
        (0..65).map(|_| Ok(vec![0; 1024 * 1024].into())),
    ));
    assert!(matches!(
        store
            .prepare(PackageKind::Browser, PackageFormat::Zip, large)
            .await,
        Err(Error::TooLarge)
    ));
    store
        .prepare(
            PackageKind::Browser,
            PackageFormat::Zip,
            body(zip(&browser_files())),
        )
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    let mut readers = Vec::new();
    for _ in 0..8 {
        readers.push(store.asset("webdemo", "dist/entry.js").await.unwrap());
    }
    assert!(matches!(
        store.asset("webdemo", "dist/entry.js").await,
        Err(Error::Conflict(_))
    ));
    drop(readers);
    assert!(store.asset("webdemo", "dist/entry.js").await.is_ok());
}

#[tokio::test]
async fn self_contained_node_package_maps_entry_without_running_install_script() {
    let (directory, store) = store().await;
    let files=vec![
        ("package.json".into(),serde_json::to_vec(&json!({"version":"1.0.0","scripts":{"install":"故意无效的安装命令"},"deviceforge":{"kind":"server","manifest":"portable.json","entrypoints":{"any":{"runtime":"node","path":"main.cjs"}}}})).unwrap()),
        ("portable.json".into(),serde_json::to_vec(&json!({"id":"nodedemo","version":"1.0.0","protocol_version":1,"operations":[{"name":"echo","title":"回显","input_schema":{"type":"object"}}]})).unwrap()),
        ("main.cjs".into(),br#"const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line); process.stdout.write(JSON.stringify({protocol_version:1,request_id:r.request_id,result:r.input}));});"#.to_vec())
    ];
    let info = store
        .prepare(PackageKind::Server, PackageFormat::Tgz, body(tgz(&files)))
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    assert_eq!(info.runtime, "node");
    assert!(info.entry_url.is_none());
    let root = tokio::fs::canonicalize(directory.path().join("server"))
        .await
        .unwrap();
    let manifest: apk_plugin_sdk::Manifest = serde_json::from_slice(
        &tokio::fs::read(root.join("nodedemo/manifest.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        std::fs::canonicalize(&manifest.args[0]).unwrap(),
        root.join("nodedemo/main.cjs")
    );
    let plugin = ProcessPlugin::new(manifest).unwrap();
    let value = plugin
        .execute(
            "plugin.nodedemo.echo",
            json!({"from":"package"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(value, json!({"from":"package"}));
}

#[tokio::test]
async fn native_entry_is_mapped_and_machine_executable_in_portable_manifest_is_rejected() {
    let (_directory, store) = store().await;
    let mut files=vec![
        ("package.json".into(),serde_json::to_vec(&json!({"version":"1.0.0","deviceforge":{"kind":"server","manifest":"portable.json","entrypoints":{"any":{"runtime":"native","path":"plugin.bin"}}}})).unwrap()),
        ("portable.json".into(),serde_json::to_vec(&json!({"id":"nativedemo","version":"1.0.0","protocol_version":3,"operations":[{"name":"run","title":"运行","input_schema":{"type":"object"}}]})).unwrap()),
        ("plugin.bin".into(),"可信模拟入口，不执行".as_bytes().to_vec())
    ];
    let prepared = store
        .prepare(PackageKind::Server, PackageFormat::Zip, body(zip(&files)))
        .await
        .unwrap();
    assert_eq!(prepared.operations()[0].id, "plugin.nativedemo.run");
    assert_eq!(prepared.commit().await.unwrap().runtime, "native");
    let mut portable: serde_json::Value = serde_json::from_slice(&files[1].1).unwrap();
    portable["executable"] = json!("C:/caller-selected.exe");
    files[1].1 = serde_json::to_vec(&portable).unwrap();
    assert!(
        store
            .prepare(PackageKind::Server, PackageFormat::Zip, body(zip(&files)))
            .await
            .is_err()
    );
}
