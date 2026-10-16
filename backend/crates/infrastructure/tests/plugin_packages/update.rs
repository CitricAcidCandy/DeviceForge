use super::*;

fn revised_files(version: &str, content: &[u8]) -> Vec<(String, Vec<u8>)> {
    browser_files()
        .into_iter()
        .map(|(name, bytes)| {
            let bytes = match name.as_str() {
                "package.json" | "browser.json" => {
                    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    manifest["version"] = json!(version);
                    serde_json::to_vec(&manifest).unwrap()
                }
                "dist/data.json" => content.to_vec(),
                _ => bytes,
            };
            (name, bytes)
        })
        .collect()
}

#[tokio::test]
async fn validated_zip_and_tgz_updates_replace_bytes_and_preserve_failed_deployments() {
    for format in [PackageFormat::Zip, PackageFormat::Tgz] {
        let (directory, store) = store().await;
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
        let files = revised_files("2.0.0", br#"{"updated":true}"#);
        let bytes = match format {
            PackageFormat::Zip => zip(&files),
            PackageFormat::Tgz => tgz(&files),
        };
        let updated = store
            .prepare(PackageKind::Browser, format, body(bytes.clone()))
            .await
            .unwrap()
            .replace()
            .await
            .unwrap();
        assert_eq!(updated.version, "2.0.0");
        assert_eq!(
            store.list(PackageKind::Browser).await.unwrap()[0].version,
            "2.0.0"
        );
        let path = directory.path().join("browser/webdemo/dist/data.json");
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            br#"{"updated":true}"#
        );

        // 同版本拒绝替换；归档验证失败同样保留已有部署和字节。
        assert!(matches!(
            store
                .prepare(PackageKind::Browser, format, body(bytes))
                .await
                .unwrap()
                .replace()
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(
            store
                .prepare(PackageKind::Browser, format, body(b"invalid".to_vec()))
                .await
                .is_err()
        );
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            br#"{"updated":true}"#
        );
        assert_eq!(
            store.list(PackageKind::Browser).await.unwrap()[0].version,
            "2.0.0"
        );
    }
}

#[tokio::test]
async fn update_requires_an_existing_online_deployment() {
    let (_directory, store) = store().await;
    let prepared = store
        .prepare(
            PackageKind::Browser,
            PackageFormat::Zip,
            body(zip(&browser_files())),
        )
        .await
        .unwrap();
    assert!(matches!(prepared.replace().await, Err(Error::NotFound(_))));
    assert!(store.list(PackageKind::Browser).await.unwrap().is_empty());
}
