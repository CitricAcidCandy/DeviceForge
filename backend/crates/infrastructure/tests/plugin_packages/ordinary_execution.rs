use super::*;
use apk_domain::OperationExecutionSource;

fn server_files(protocol: u32, runtime: &str) -> Vec<(String, Vec<u8>)> {
    let entry = if runtime == "node" {
        "entry.mjs"
    } else {
        "plugin.bin"
    };
    vec![
        (
            "package.json".into(),
            serde_json::to_vec(&json!({
                "version":"1.0.0","deviceforge":{"kind":"server","manifest":"portable.json",
                    "entrypoints":{"any":{"runtime":runtime,"path":entry}}}
            }))
            .unwrap(),
        ),
        (
            "portable.json".into(),
            serde_json::to_vec(&json!({
                "id":"budget_demo","version":"1.0.0","protocol_version":protocol,
                "operations":[
                    {"name":"build","title":"构建","input_schema":{"type":"object"},
                        "execution":{"api_version":1,"total_timeout_ms":180_000}},
                    {"name":"legacy","title":"兼容操作","input_schema":{"type":"object"}}
                ]
            }))
            .unwrap(),
        ),
        (
            entry.into(),
            "仅验证安装和路径映射，不执行入口".as_bytes().to_vec(),
        ),
    ]
}

async fn package_store() -> (tempfile::TempDir, FilePluginPackages) {
    let directory = tempfile::tempdir().unwrap();
    // 这里只验证管理员入口映射，用现有测试文件代替 Node 入口且从不启动它。
    let store = FilePluginPackages::open(
        &directory.path().join("server"),
        &directory.path().join("browser"),
        Some(std::env::current_exe().unwrap()),
    )
    .await
    .unwrap();
    (directory, store)
}

fn archive(format: PackageFormat, files: &[(String, Vec<u8>)]) -> Vec<u8> {
    match format {
        PackageFormat::Zip => zip(files),
        PackageFormat::Tgz => tgz(files),
    }
}

#[tokio::test]
async fn native_and_node_archives_preserve_declared_budget_without_inventing_default() {
    for protocol in [1, 2, 3] {
        for runtime in ["native", "node"] {
            for format in [PackageFormat::Zip, PackageFormat::Tgz] {
                let (directory, store) = package_store().await;
                let files = server_files(protocol, runtime);
                let prepared = store
                    .prepare(PackageKind::Server, format, body(archive(format, &files)))
                    .await
                    .unwrap();
                let operations = prepared.operations();
                let declared = operations[0].execution.unwrap();
                assert_eq!(declared.api_version, 1);
                assert_eq!(declared.total_timeout_ms, 180_000);
                assert_eq!(declared.source, OperationExecutionSource::Declared);
                assert!(operations[1].execution.is_none());
                prepared.commit().await.unwrap();

                let saved: apk_plugin_sdk::Manifest = serde_json::from_slice(
                    &tokio::fs::read(directory.path().join("server/budget_demo/manifest.json"))
                        .await
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(saved.protocol_version, protocol);
                assert_eq!(
                    saved.operations[0].execution.unwrap().total_timeout_ms,
                    180_000
                );
                assert!(saved.operations[1].execution.is_none());
                let loaded = ProcessPlugin::new(saved).unwrap();
                assert_eq!(loaded.operations()[0].execution, Some(declared));
                assert!(loaded.operations()[1].execution.is_none());
            }
        }
    }
}

#[tokio::test]
async fn invalid_and_special_repeated_budgets_never_publish_a_package() {
    let (directory, store) = package_store().await;
    let files = server_files(2, "native");
    let original: serde_json::Value = serde_json::from_slice(&files[1].1).unwrap();
    let mut cases = Vec::new();
    for execution in [
        json!({"api_version":2,"total_timeout_ms":60_000}),
        json!({"api_version":1,"total_timeout_ms":0}),
        json!({"api_version":1,"total_timeout_ms":3_600_001}),
        json!({"api_version":1,"total_timeout_ms":"60000"}),
        json!({"api_version":1,"total_timeout_ms":60_000,"extra":true}),
    ] {
        let mut value = original.clone();
        value["operations"][0]["execution"] = execution;
        cases.push(value);
    }
    let mut performance = original.clone();
    performance["performance"] = json!({"sample_operation":"build"});
    cases.push(performance);
    let mut discovery = original.clone();
    discovery["devices"] = json!({"api_version":3,"platform":"synthetic_demo",
        "discover_operation":"build","capabilities":[{"id":"echo","version":1,
            "operation":"legacy","scope":"device","access":"read"}]});
    discovery["operations"][1]["input_schema"] = json!({"type":"object",
        "required":["device_id","input"],"additionalProperties":false,
        "properties":{"device_id":{"type":"string"},"input":{"type":"object"}}});
    let mut capability = discovery.clone();
    let execution = capability["operations"][0]
        .as_object_mut()
        .unwrap()
        .remove("execution")
        .unwrap();
    capability["operations"][1]["execution"] = execution;
    cases.extend([discovery, capability]);
    for value in cases {
        for format in [PackageFormat::Zip, PackageFormat::Tgz] {
            let mut invalid = files.clone();
            invalid[1].1 = serde_json::to_vec(&value).unwrap();
            assert!(matches!(
                store
                    .prepare(PackageKind::Server, format, body(archive(format, &invalid)))
                    .await,
                Err(Error::Invalid(_))
            ));
            assert!(store.list(PackageKind::Server).await.unwrap().is_empty());
            assert!(!directory.path().join("server/budget_demo").exists());
        }
    }
}
