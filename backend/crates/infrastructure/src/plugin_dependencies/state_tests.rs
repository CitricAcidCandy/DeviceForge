use super::*;
use std::{collections::BTreeMap, fs};

fn persist(
    store: &FilePluginDependencies,
    target: &targets::ResolvedTarget,
    state: &state::BindingState,
    expected: &str,
) -> Result<()> {
    state::persist(
        &store.root,
        &store.repository,
        target,
        state,
        expected,
        &CancellationToken::new(),
        Instant::now() + Duration::from_secs(10),
    )
}

fn external_state(
    store: &FilePluginDependencies,
    target: &targets::ResolvedTarget,
) -> state::BindingState {
    let executable = store.root.join("external-tool");
    fs::write(&executable, b"external").unwrap();
    state::BindingState {
        manifest_revision: target.revision.clone(),
        sequence: 1,
        selected: BTreeMap::from([(
            "shared-runtime".into(),
            state::Selection {
                origin: DependencyOrigin::Local,
                version: "unversioned".into(),
                entries: BTreeMap::from([("program".into(), executable)]),
                key: None,
            },
        )]),
        deployments: target
            .components
            .iter()
            .map(|component| {
                (
                    state::target_key(&DependencyTarget {
                        kind: component.kind,
                        id: component.id.clone(),
                    }),
                    component.deployment_digest.clone(),
                )
            })
            .collect(),
        ..Default::default()
    }
}

#[tokio::test]
async fn failed_second_snapshot_never_invalidates_previous_index_or_first_snapshot() {
    let (_temporary, store) = tests::fixture().await;
    let target = tests::deploy(&store, "atomic-binding", vec![tests::dependency("*")]);
    let mut resolved = store.resolve(target.clone()).unwrap();
    resolved.components.push(targets::Component {
        kind: DependencyTargetKind::Browser,
        id: "second-component".into(),
        deployment_digest: "second-deployment".into(),
        runtime: None,
    });
    resolved.manifest.dependencies[0]
        .bindings
        .push(DependencyBinding {
            component_id: "second-component".into(),
            config_pointer: "/program".into(),
            entry: "program".into(),
        });
    let initial = state::load(&store.root, &resolved).unwrap();
    let mut selected = external_state(&store, &resolved);
    persist(
        &store,
        &resolved,
        &selected,
        &state::revision(&resolved, &initial).unwrap(),
    )
    .unwrap();
    let old_index = fs::read(state::path(&store.root, &target)).unwrap();
    let old_snapshot = state::valid_snapshot(&store.root, &resolved, &resolved.components[0])
        .unwrap()
        .unwrap();
    let old_bytes = fs::read(&old_snapshot).unwrap();
    let expected = state::revision(&resolved, &selected).unwrap();
    selected.sequence += 1;
    let next_revision = state::revision(&resolved, &selected).unwrap();
    let blocked = state::snapshot_path(
        &store.root,
        DependencyTargetKind::Browser,
        "second-component",
    )
    .with_extension("")
    .join(format!("{next_revision}.json"));
    fs::create_dir_all(blocked).unwrap();
    assert!(persist(&store, &resolved, &selected, &expected).is_err());
    assert_eq!(
        fs::read(state::path(&store.root, &target)).unwrap(),
        old_index
    );
    assert_eq!(fs::read(&old_snapshot).unwrap(), old_bytes);
    assert_eq!(
        state::valid_snapshot(&store.root, &resolved, &resolved.components[0]).unwrap(),
        Some(old_snapshot)
    );
}

#[tokio::test]
async fn revision_compare_and_swap_and_file_lock_work_across_independent_store_handles() {
    let (_temporary, store) = tests::fixture().await;
    let target = tests::deploy(&store, "cas-binding", vec![tests::dependency("*")]);
    let other = FilePluginDependencies::open(
        &store.root,
        store.server_roots.clone(),
        store.browser_roots.clone(),
    )
    .await
    .unwrap();
    let resolved = store.resolve(target.clone()).unwrap();
    let initial = state::load(&store.root, &resolved).unwrap();
    let expected = state::revision(&resolved, &initial).unwrap();
    let mut selected = external_state(&store, &resolved);
    let lock = files::state_lock(&store.root).unwrap();
    assert!(matches!(
        persist(&other, &resolved, &selected, &expected),
        Err(Error::Conflict(_))
    ));
    drop(lock);
    persist(&store, &resolved, &selected, &expected).unwrap();
    let saved = fs::read(state::path(&store.root, &target)).unwrap();
    selected.sequence += 1;
    assert!(matches!(
        persist(&other, &resolved, &selected, &expected),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read(state::path(&store.root, &target)).unwrap(), saved);
}

#[tokio::test]
async fn forget_refuses_foreign_snapshot_and_keeps_index_and_repository_reference() {
    let (_temporary, store) = tests::fixture().await;
    let key = tests::publish(&store, "1.2.3", 'a');
    let target = tests::deploy(&store, "foreign-snapshot", vec![tests::dependency("^1")]);
    assert!(tests::install(&store, target.clone()).await.unwrap().ready);
    let snapshot = store
        .component_snapshot(target.kind, &target.id)
        .await
        .unwrap()
        .unwrap();
    let mut value: serde_json::Value = files::json(&snapshot).unwrap();
    value["release_id"] = serde_json::json!("another-owner");
    files::write(&snapshot, &value).unwrap();
    let index = fs::read(state::path(&store.root, &target)).unwrap();
    assert!(matches!(
        store.forget(target.clone()).await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read(state::path(&store.root, &target)).unwrap(), index);
    assert_eq!(files::json::<serde_json::Value>(&snapshot).unwrap(), value);
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
}

#[tokio::test]
async fn runtime_dependency_without_configuration_bindings_is_in_snapshot_and_lease_identity() {
    let (_temporary, store) = tests::fixture().await;
    let key = tests::publish(&store, "1.2.3", 'a');
    let mut runtime = tests::dependency("^1");
    runtime.bindings.clear();
    let target = tests::deploy(&store, "script-with-runtime", vec![runtime]);
    files::write(&store.server_roots[0].join(&target.id).join(".deviceforge-runtime.json"),
        &serde_json::json!({"format_version": 1, "dependency": {"id": "shared-runtime", "entry": "program"}})).unwrap();
    assert!(tests::install(&store, target.clone()).await.unwrap().ready);
    let snapshot = store
        .component_snapshot(target.kind, &target.id)
        .await
        .unwrap()
        .unwrap();
    let resources = apk_plugin_sdk::resources::ManagedResources::read(&snapshot).unwrap();
    assert!(resources.bindings.is_empty());
    assert_eq!(resources.tools["shared-runtime"].version, "1.2.3");
    assert_eq!(
        resources.managed_tools.as_ref().unwrap()["shared-runtime"],
        key.version
    );
    assert_eq!(
        resources.entry("shared-runtime", "program").unwrap(),
        store
            .repository
            .path(&key)
            .unwrap()
            .join("nested/runtime.bin")
    );
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
    assert_eq!(
        store
            .component_managed_keys(target.kind, &target.id)
            .await
            .unwrap(),
        vec![key]
    );
}

#[tokio::test]
async fn release_runtime_without_bindings_is_owned_by_the_runtime_component_only() {
    use apk_domain::{
        plugin_installations::{InstallationStatus, InstalledComponent, InstalledRelease},
        plugin_packages::PackageKind,
    };
    let (_temporary, store) = tests::fixture().await;
    let key = tests::publish(&store, "1.2.3", 'a');
    let mut runtime = tests::dependency("^1");
    runtime.bindings.clear();
    let script = tests::deploy(&store, "release-script", vec![runtime]);
    tests::deploy(&store, "release-other", Vec::new());
    files::write(&store.server_roots[0].join(&script.id).join(".deviceforge-runtime.json"),
        &serde_json::json!({"format_version": 1, "dependency": {"id": "shared-runtime", "entry": "program"}})).unwrap();
    let revision = "c".repeat(64);
    let release = InstalledRelease {
        id: "script-release".into(),
        version: "1.0.0".into(),
        name: "脚本发布".into(),
        description: String::new(),
        revision: revision.clone(),
        enabled: false,
        status: InstallationStatus::Installed,
        failure: None,
        installed_at: 0,
        components: ["release-script", "release-other"]
            .into_iter()
            .map(|id| InstalledComponent {
                id: id.into(),
                kind: PackageKind::Server,
                version: "1.0.0".into(),
                revision: "d".repeat(64),
                entry_path: "entry.js".into(),
                entry_url: None,
            })
            .collect(),
        tools: Vec::new(),
        requirements: Vec::new(),
    };
    files::write(
        &store
            .root
            .join("installations/releases/script-release.json"),
        &release,
    )
    .unwrap();
    files::write(
        &store
            .root
            .join("installations/manifests")
            .join(format!("{revision}.json")),
        &serde_json::json!({"id": "script-release"}),
    )
    .unwrap();
    let installed = tests::install(&store, script.clone()).await.unwrap();
    assert!(installed.ready);
    assert_eq!(installed.target.kind, DependencyTargetKind::Release);
    let snapshot = store
        .component_snapshot(script.kind, &script.id)
        .await
        .unwrap()
        .unwrap();
    let resources = apk_plugin_sdk::resources::ManagedResources::read(&snapshot).unwrap();
    assert_eq!(resources.release_id, release.id);
    assert!(resources.bindings.is_empty());
    assert!(resources.tools.contains_key("shared-runtime"));
    assert_eq!(
        store
            .component_managed_keys(script.kind, &script.id)
            .await
            .unwrap(),
        vec![key]
    );
    assert!(
        store
            .component_snapshot(DependencyTargetKind::Server, "release-other")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .component_managed_keys(DependencyTargetKind::Server, "release-other")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn runtime_metadata_rejects_optional_missing_or_unknown_entry_dependencies() {
    let (_temporary, store) = tests::fixture().await;
    let mut runtime = tests::dependency("^1");
    runtime.required = false;
    let target = tests::deploy(&store, "invalid-runtime-reference", vec![runtime]);
    let marker = store.server_roots[0]
        .join(&target.id)
        .join(".deviceforge-runtime.json");
    for reference in [
        serde_json::json!({"id": "shared-runtime", "entry": "program"}),
        serde_json::json!({"id": "missing", "entry": "program"}),
        serde_json::json!({"id": "shared-runtime", "entry": "missing"}),
    ] {
        files::write(
            &marker,
            &serde_json::json!({"format_version": 1, "dependency": reference}),
        )
        .unwrap();
        assert!(matches!(
            store.get(target.clone()).await,
            Err(Error::Invalid(_))
        ));
    }
}
