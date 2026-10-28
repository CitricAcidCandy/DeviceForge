use super::*;

#[tokio::test]
async fn generated_identity_entry_installs_and_serves_from_zip_and_tgz() {
    use futures_util::{TryStreamExt, stream};
    use serde_json::json;
    use std::io::{Cursor, Write};

    let entry = b"import plugin from './index.js'; export default plugin;";
    let files = [
        (
            "package.json",
            serde_json::to_vec(&json!({"version":"1.0.0","deviceforge":{
            "kind":"browser","manifest":"plugin.json","entrypoints":{
                "any":{"runtime":"browser","path":".deviceforge-entry.js"}}}}))
            .unwrap(),
        ),
        (
            "plugin.json",
            serde_json::to_vec(&json!({"id":"identity_fixture","version":"1.0.0","api_version":2}))
                .unwrap(),
        ),
        (".deviceforge-entry.js", entry.to_vec()),
        ("index.js", b"export default {panels:[]};".to_vec()),
        (".assets/data.txt", b"dot-resource".to_vec()),
    ];
    for format in [PackageFormat::Zip, PackageFormat::Tgz] {
        let temporary = tempfile::tempdir().unwrap();
        let store = FilePluginPackages::open(
            &temporary.path().join("server"),
            &temporary.path().join("browser"),
            None,
        )
        .await
        .unwrap();
        let bytes = if matches!(format, PackageFormat::Zip) {
            let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (path, bytes) in &files {
                archive
                    .start_file(*path, zip::write::SimpleFileOptions::default())
                    .unwrap();
                archive.write_all(bytes).unwrap();
            }
            archive.finish().unwrap().into_inner()
        } else {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut archive = tar::Builder::new(gzip);
            for (path, bytes) in &files {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive
                    .append_data(&mut header, format!("package/{path}"), bytes.as_slice())
                    .unwrap();
            }
            archive.into_inner().unwrap().finish().unwrap()
        };
        let prepared = store
            .prepare(
                PackageKind::Browser,
                format,
                Box::pin(stream::once(async move { Ok(bytes.into()) })),
            )
            .await
            .unwrap();
        let info = prepared.commit().await.unwrap();
        assert_eq!(info.entry_path, ".deviceforge-entry.js");
        let asset = store
            .asset(&info.id, ".deviceforge-entry.js")
            .await
            .unwrap();
        assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
        assert_eq!(
            asset.stream.try_collect::<Vec<_>>().await.unwrap().concat(),
            entry
        );
        let asset = store.asset(&info.id, ".assets/data.txt").await.unwrap();
        assert_eq!(
            asset.stream.try_collect::<Vec<_>>().await.unwrap().concat(),
            b"dot-resource"
        );
        assert!(
            store
                .asset(&info.id, ".deviceforge-package.json")
                .await
                .is_err()
        );
        assert!(
            store
                .asset(&info.id, ".deviceforge-runtime.json")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn publication_failure_restores_the_old_directory_and_manifest() {
    let directory = tempfile::tempdir().unwrap();
    let store = FilePluginPackages::open(
        &directory.path().join("server"),
        &directory.path().join("browser"),
        None,
    )
    .await
    .unwrap();
    let root = store.root(PackageKind::Browser);
    let destination = root.path.join("rollback_demo");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("entry.js"), "旧包原字节").unwrap();
    let mut info = PackageInfo {
        kind: PackageKind::Browser,
        id: "rollback_demo".into(),
        version: "1.0.0".into(),
        runtime: "browser".into(),
        entry_path: "entry.js".into(),
        entry_url: None,
        api_version: Some(2),
        installed_at: 0,
    };
    storage::write_info(&destination, &info).unwrap();
    info.version = "2.0.0".into();
    // 模拟已验证暂存随后不可发布，强制进入旧包已移出后的回滚分支。
    let staged = tempfile::Builder::new()
        .prefix(".package-")
        .tempdir_in(&root.path)
        .unwrap();
    let prepared = Prepared {
        staging: Staging {
            directory: Some(staged),
            upload: None,
        },
        root: root.clone(),
        info,
        operations: vec![],
        workers: store.workers.clone(),
    };
    assert!(matches!(storage::replace(prepared), Err(Error::Storage(_))));
    assert_eq!(
        fs::read_to_string(destination.join("entry.js")).unwrap(),
        "旧包原字节"
    );
    assert_eq!(
        storage::list(&root, PackageKind::Browser).unwrap()[0].version,
        "1.0.0"
    );
}
