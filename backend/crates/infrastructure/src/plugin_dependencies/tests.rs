//! 全部夹具使用独占临时目录，不修改 Windows 全局环境，也不依赖真实设备。
use super::*;
use apk_domain::{ExecutionContext, NoProgress};
use std::{collections::BTreeMap, fs};

pub(super) fn dependency(requirement: &str) -> Dependency {
    Dependency {
        id: "shared-runtime".into(),
        name: "测试运行时".into(),
        version_requirement: requirement.into(),
        required: true,
        entries: vec!["program".into()],
        requires: Vec::new(),
        discovery: Vec::new(),
        probe: None,
        sources: Vec::new(),
        bindings: vec![DependencyBinding {
            component_id: String::new(),
            config_pointer: "/program".into(),
            entry: "program".into(),
        }],
    }
}

pub(super) async fn fixture() -> (tempfile::TempDir, Arc<FilePluginDependencies>) {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = FilePluginDependencies::open(
        &temporary.path().join("user"),
        vec![temporary.path().join("server")],
        vec![temporary.path().join("browser")],
    )
    .await
    .unwrap();
    Arc::get_mut(&mut store).unwrap().client =
        download::client_builder().no_proxy().build().unwrap();
    (temporary, store)
}

pub(super) fn deploy(
    store: &FilePluginDependencies,
    id: &str,
    dependencies: Vec<Dependency>,
) -> DependencyTarget {
    let directory = store.server_roots[0].join(id);
    fs::create_dir_all(&directory).unwrap();
    files::write(
        &directory.join("manifest.json"),
        &serde_json::json!({"id": id}),
    )
    .unwrap();
    files::write(
        &directory.join("dependencies.json"),
        &DependencyManifest {
            format_version: 1,
            dependencies,
        },
    )
    .unwrap();
    DependencyTarget {
        kind: DependencyTargetKind::Server,
        id: id.into(),
    }
}

pub(super) fn publish(store: &FilePluginDependencies, version: &str, digest: char) -> ToolKey {
    let stage = store.repository.stage().unwrap();
    let payload = stage.path().join("payload");
    fs::create_dir_all(payload.join("nested")).unwrap();
    fs::write(payload.join("nested/runtime.bin"), version).unwrap();
    let key = ToolKey {
        id: "shared-runtime".into(),
        version: format!("{version}+dep.test"),
        platform: Repository::platform(),
        sha256: digest.to_string().repeat(64),
    };
    let writer = store.repository.write().unwrap();
    writer.publish(&key, &payload, &|| Ok(())).unwrap();
    writer
        .register_tool(
            &key,
            version,
            &BTreeMap::from([("program".into(), "nested/runtime.bin".into())]),
            &|| Ok(()),
        )
        .unwrap();
    key
}

pub(super) async fn install(
    store: &FilePluginDependencies,
    target: DependencyTarget,
) -> Result<PluginDependencies> {
    let revision = store.get(target.clone()).await?.revision;
    store
        .install(
            DependencyRequest {
                target,
                expected_revision: revision,
                dependency_ids: Vec::new(),
            },
            CancellationToken::new(),
            ExecutionContext::default(),
            Arc::new(NoProgress),
        )
        .await
}

#[tokio::test]
async fn empty_dependencies_need_no_repository_write_and_keep_revision() {
    let (_temporary, store) = fixture().await;
    let target = deploy(&store, "empty-plugin", Vec::new());
    let before = store.get(target.clone()).await.unwrap();
    let _writer = store.repository.write().unwrap();
    let after = install(&store, target.clone()).await.unwrap();
    assert!(after.ready);
    assert_eq!(after.revision, before.revision);
    assert!(!state::path(&store.root, &target).exists());
}

#[tokio::test]
async fn third_party_plugins_share_without_sources_and_forget_only_their_own_reference() {
    let (_temporary, store) = fixture().await;
    let key = publish(&store, "1.2.3", 'a');
    let a = deploy(&store, "third-party-a", vec![dependency("^1")]);
    let b = deploy(&store, "third-party-b", vec![dependency("^1")]);
    assert!(install(&store, a.clone()).await.unwrap().ready);
    assert!(install(&store, b.clone()).await.unwrap().ready);
    let writer = store.repository.write().unwrap();
    assert_eq!(writer.references(&key).unwrap().len(), 2);
    assert!(matches!(
        writer.remove(&key, &|| Ok(())),
        Err(deviceforge_tool_repository::Error::InUse)
    ));
    drop(writer);
    let b_snapshot = store
        .component_snapshot(b.kind, &b.id)
        .await
        .unwrap()
        .unwrap();
    store.forget(a).await.unwrap();
    assert!(b_snapshot.exists());
    assert_eq!(
        store
            .repository
            .write()
            .unwrap()
            .references(&key)
            .unwrap()
            .len(),
        1
    );
    store.forget(b).await.unwrap();
    let writer = store.repository.write().unwrap();
    assert!(writer.references(&key).unwrap().is_empty());
    assert!(store.repository.path(&key).unwrap().exists());
}

#[tokio::test]
async fn incompatible_versions_coexist_and_failed_install_preserves_previous_state() {
    let (_temporary, store) = fixture().await;
    let v1 = publish(&store, "1.2.3", 'a');
    let v2 = publish(&store, "2.0.0", 'b');
    let a = deploy(&store, "version-one", vec![dependency("^1")]);
    let b = deploy(&store, "version-two", vec![dependency("^2")]);
    assert_eq!(
        install(&store, a.clone()).await.unwrap().dependencies[0]
            .version
            .as_deref(),
        Some("1.2.3")
    );
    assert_eq!(
        install(&store, b).await.unwrap().dependencies[0]
            .version
            .as_deref(),
        Some("2.0.0")
    );
    let previous = fs::read(state::path(&store.root, &a)).unwrap();
    let snapshot = store
        .component_snapshot(a.kind, &a.id)
        .await
        .unwrap()
        .unwrap();
    let mut missing = dependency("^3");
    missing.id = "missing-tool".into();
    missing.bindings[0].config_pointer = "/missing".into();
    deploy(&store, &a.id, vec![dependency("^1"), missing]);
    assert!(install(&store, a.clone()).await.is_err());
    assert_eq!(fs::read(state::path(&store.root, &a)).unwrap(), previous);
    assert!(snapshot.exists());
    let writer = store.repository.write().unwrap();
    assert_eq!(writer.references(&v1).unwrap().len(), 1);
    assert_eq!(writer.references(&v2).unwrap().len(), 1);
}

#[test]
fn probe_child() {
    println!("dependency-probe-version=1.2.3");
}

#[tokio::test]
async fn saved_configuration_is_optional_and_defaults_do_not_override_local_discovery() {
    let (_temporary, store) = fixture().await;
    let local = store.root.join("local-tool");
    let explicit = store.root.join("explicit-tool");
    fs::write(&local, b"local").unwrap();
    fs::write(&explicit, b"explicit").unwrap();
    let mut definition = dependency("*");
    definition.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "local-tool".into(),
        entries: BTreeMap::from([("program".into(), ".".into())]),
    });
    let target = deploy(&store, "config-candidate", vec![definition]);
    let configuration = store
        .root
        .join("plugin-configurations/server/config-candidate/state.json");
    files::write(
        &configuration,
        &serde_json::json!({ "source": "defaults", "values": { "program": explicit } }),
    )
    .unwrap();
    let _writer = store.repository.write().unwrap();
    assert!(install(&store, target.clone()).await.unwrap().ready);
    let resolved = store.resolve(target.clone()).unwrap();
    let selected = state::load(&store.root, &resolved).unwrap();
    assert_eq!(
        selected.selected["shared-runtime"].entries["program"],
        files::file(&local).unwrap()
    );
    files::write(
        &configuration,
        &serde_json::json!({ "source": "managed", "values": { "program": explicit } }),
    )
    .unwrap();
    assert!(install(&store, target.clone()).await.unwrap().ready);
    let selected = state::load(&store.root, &resolved).unwrap();
    assert_eq!(
        selected.selected["shared-runtime"].entries["program"],
        files::file(&explicit).unwrap()
    );
}

#[tokio::test]
async fn invalid_manual_override_neither_downloads_nor_masquerades_as_ready() {
    let (_temporary, store) = fixture().await;
    let local = store.root.join("local-tool");
    fs::write(&local, b"local").unwrap();
    let mut definition = dependency("*");
    definition.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "local-tool".into(),
        entries: BTreeMap::from([("program".into(), ".".into())]),
    });
    let target = deploy(&store, "manual-invalid", vec![definition]);
    let configuration = store
        .root
        .join("plugin-configurations/server/manual-invalid/state.json");
    files::write(
        &configuration,
        &serde_json::json!({"source":"managed","values":{"program":"missing/relative/tool"}}),
    )
    .unwrap();
    let _writer = store.repository.write().unwrap();
    let result = install(&store, target.clone()).await.unwrap();
    assert!(!result.ready);
    assert_eq!(
        result.dependencies[0].status,
        DependencyStatus::Incompatible
    );
    assert!(
        state::load(&store.root, &store.resolve(target).unwrap())
            .unwrap()
            .selected
            .is_empty()
    );
}

#[tokio::test]
async fn registered_user_tool_is_reused_without_installer_or_discovery_layout_and_rejects_changed_bytes()
 {
    let (_temporary, store) = fixture().await;
    let local = store.root.join("vendor-tool");
    fs::write(&local, b"original").unwrap();
    let mut definition = dependency("*");
    definition.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "vendor-tool".into(),
        entries: BTreeMap::from([("program".into(), ".".into())]),
    });
    let a = deploy(&store, "local-installer", vec![definition]);
    assert!(install(&store, a.clone()).await.unwrap().ready);
    store.forget(a).await.unwrap();
    let b = deploy(&store, "local-consumer", vec![dependency("*")]);
    assert!(install(&store, b.clone()).await.unwrap().ready);
    fs::write(local, b"modified").unwrap();
    // 新消费者不能凭旧版本登记信任被替换的外部文件。
    let c = deploy(&store, "local-later", vec![dependency("*")]);
    let current = store.get(c.clone()).await.unwrap();
    let result = store
        .scan(
            DependencyRequest {
                target: c,
                expected_revision: current.revision,
                dependency_ids: Vec::new(),
            },
            CancellationToken::new(),
            Default::default(),
            Arc::new(NoProgress),
        )
        .await
        .unwrap();
    assert!(!result.ready);
    assert!(store.repository.write().is_ok());
}

#[tokio::test]
async fn version_probe_uses_current_test_executable_without_global_environment_changes() {
    let (_temporary, store) = fixture().await;
    let executable = std::env::current_exe().unwrap();
    let mut definition = dependency("^1.2");
    definition.probe = Some(VersionProbe {
        entry: "program".into(),
        args: vec![
            "--exact".into(),
            "plugin_dependencies::tests::probe_child".into(),
            "--nocapture".into(),
        ],
        pattern: "dependency-probe-version=([0-9.]+)".into(),
        timeout_ms: 10_000,
    });
    let candidate = discovery::Candidate {
        selection: state::Selection {
            origin: DependencyOrigin::Local,
            version: String::new(),
            entries: BTreeMap::from([("program".into(), executable)]),
            key: None,
        },
        lease: None,
        stage: None,
    };
    assert_eq!(
        discovery::probe(
            &definition,
            candidate.clone(),
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(20)
        )
        .await
        .unwrap()
        .version,
        "1.2.3"
    );
    definition.version_requirement = "^2".into();
    assert!(
        discovery::probe(
            &definition,
            candidate.clone(),
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(20)
        )
        .await
        .is_err()
    );
    definition.entries.push("missing-entry".into());
    assert!(
        discovery::probe(
            &definition,
            candidate,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(20)
        )
        .await
        .is_err()
    );
    assert!(store.repository.write().is_ok());
}

#[tokio::test]
async fn local_directory_mappings_require_every_entry_and_keep_local_files_untouched() {
    let (_temporary, store) = fixture().await;
    let local = store.root.join("vendor/bin");
    fs::create_dir_all(&local).unwrap();
    fs::write(local.join("main"), b"main").unwrap();
    let mut definition = dependency("*");
    definition.entries.push("helper".into());
    definition.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "vendor".into(),
        entries: BTreeMap::from([
            ("program".into(), "bin/main".into()),
            ("helper".into(), "bin/helper".into()),
        ]),
    });
    assert!(discovery::local(&store.root, &definition).is_empty());
    fs::write(local.join("helper"), b"helper").unwrap();
    let target = deploy(&store, "local-layout", vec![definition]);
    assert!(install(&store, target.clone()).await.unwrap().ready);
    store.forget(target).await.unwrap();
    assert_eq!(fs::read(local.join("main")).unwrap(), b"main");
    assert_eq!(fs::read(local.join("helper")).unwrap(), b"helper");
}

#[tokio::test]
async fn prerequisite_order_and_group_installability_include_found_main_tool() {
    let (_temporary, store) = fixture().await;
    let main = store.root.join("main-tool");
    fs::write(&main, b"main").unwrap();
    let mut definition = dependency("*");
    definition.requires = vec!["java-runtime".into()];
    definition.discovery.push(DiscoveryRule {
        kind: DiscoveryKind::UserDirectory,
        value: "main-tool".into(),
        entries: BTreeMap::from([("program".into(), ".".into())]),
    });
    let mut java = dependency("^1");
    java.id = "java-runtime".into();
    java.required = false;
    java.bindings.clear();
    java.sources.push(DependencySource {
        kind: SourceKind::Market,
        url: "http://127.0.0.1:1/missing".into(),
        platform: Repository::platform(),
        version: "1.2.3".into(),
        sha256: "a".repeat(64),
        size: 1,
        format: ArchiveFormat::File,
        entries: BTreeMap::from([("program".into(), "java".into())]),
    });
    let target = deploy(&store, "main-before-java", vec![definition, java]);
    let resolved = store.resolve(target.clone()).unwrap();
    assert_eq!(
        workflow::selected_ids(&resolved, &[], true).unwrap(),
        vec!["java-runtime", "shared-runtime"]
    );
    let revision = store.get(target.clone()).await.unwrap().revision;
    let scanned = store
        .scan(
            DependencyRequest {
                target,
                expected_revision: revision,
                dependency_ids: Vec::new(),
            },
            CancellationToken::new(),
            ExecutionContext::default(),
            Arc::new(NoProgress),
        )
        .await
        .unwrap();
    assert!(!scanned.ready);
    assert!(scanned.dependencies[0].installable);
    assert_eq!(
        scanned.dependencies[0].version.as_deref(),
        Some("unversioned")
    );
    assert!(scanned.dependencies[1].installable);
}
