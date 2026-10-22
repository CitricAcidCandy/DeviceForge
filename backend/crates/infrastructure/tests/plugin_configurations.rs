use apk_domain::{Error, plugin_configurations::*};
use apk_infrastructure::plugin_configurations::FilePluginConfigurations;
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc};

struct Fixture {
    directory: tempfile::TempDir,
    store: Arc<FilePluginConfigurations>,
    manifest: Value,
}
impl Fixture {
    async fn new(policy: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let deployment = directory.path().join("plugins/demo/bin");
        fs::create_dir_all(&deployment).unwrap();
        let manifest = json!({
            "id":"demo","version":"1.0.0","protocol_version":1,
            "executable":deployment.join("plugin.exe"),"args":[],
            "operations":[{"name":"echo","title":"测试","input_schema":{"type":"object"}}],
            "configuration":{
                "version":1,"apply_policy":policy,"legacy_filename":"legacy.json",
                "schema":{"type":"object","additionalProperties":false,
                    "properties":{
                        "count":{"type":"integer","minimum":1},
                        "identity":{"type":"string","readOnly":true},
                        "environment":{"type":"object","additionalProperties":{"type":"string","writeOnly":true,"format":"password","default":"sensitive-default"}},
                        "token":{"type":"string","writeOnly":true}
                    },"required":["count","identity","environment"]},
                "defaults":{"count":1,"identity":"demo","environment":{},"token":"default-secret"}
            }
        });
        fs::write(
            deployment.parent().unwrap().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            deployment.join("legacy.json"),
            br#"{"count":2,"token":"legacy-secret","environment":{"PRIVATE":"private-secret"}}"#,
        )
        .unwrap();
        let store = FilePluginConfigurations::open(
            &directory.path().join("managed"),
            &directory.path().join("plugins"),
        )
        .await
        .unwrap();
        Self {
            directory,
            store,
            manifest,
        }
    }
    fn write_manifest(&self) {
        fs::write(
            self.directory.path().join("plugins/demo/manifest.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
    }
    fn raw(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }
}

#[tokio::test]
async fn legacy_is_copied_once_then_cas_and_masked_merge_control_user_snapshots() {
    let fixture = Fixture::new("next_invocation").await;
    let view = fixture.store.get("demo").await.unwrap();
    assert!(matches!(view.source, ConfigurationSource::Legacy));
    assert_eq!(view.values["count"], 2);
    assert_eq!(view.values["token"], "********");
    assert_eq!(view.values["environment"]["PRIVATE"], "********");
    assert!(
        view.definition.unwrap().schema["properties"]["environment"]["additionalProperties"]
            .get("default")
            .is_none()
    );
    let initial = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Fixture::raw(&initial)["count"], 2);
    fs::write(
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json"),
        br#"{"count":3,"token":"changed-secret","environment":{"PRIVATE":"changed-map-secret"}}"#,
    )
    .unwrap();
    assert_eq!(fixture.store.get("demo").await.unwrap().values["count"], 2);
    let saved = fixture
        .store
        .patch(
            "demo",
            0,
            json!({"count":4,"token":"********","environment":{"PRIVATE":"********"}}),
        )
        .await
        .unwrap();
    assert!(saved.compatible);
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.applied_revision, 1);
    let snapshot = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    let raw = Fixture::raw(&snapshot);
    assert_eq!(raw["token"], "legacy-secret");
    assert_eq!(raw["environment"]["PRIVATE"], "private-secret");
    assert!(matches!(
        fixture.store.patch("demo", 0, json!({"count":5})).await,
        Err(Error::Conflict(_))
    ));
    let invalid = fixture
        .store
        .patch("demo", 1, json!({"count":0,"identity":"other"}))
        .await
        .unwrap();
    assert!(!invalid.compatible);
    assert_eq!(invalid.revision, 1);
    assert!(
        invalid
            .field_errors
            .iter()
            .any(|value| value.path == "/count")
    );
    assert!(
        invalid
            .field_errors
            .iter()
            .any(|value| value.path == "/identity")
    );
    let cleared = fixture
        .store
        .patch(
            "demo",
            1,
            json!({"token":null,"environment":{"PRIVATE":null}}),
        )
        .await
        .unwrap();
    assert_eq!(cleared.revision, 2);
    assert!(cleared.values.get("token").is_none());
    assert_eq!(Fixture::raw(&snapshot), raw, "活动调用持有的旧文件必须不变");
    let reset = fixture.store.reset("demo", 2).await.unwrap();
    assert_eq!(reset.revision, 3);
    assert_eq!(reset.values["count"], 1);
}

#[tokio::test]
async fn valid_legacy_record_is_not_augmented_with_mutually_exclusive_defaults() {
    let mut fixture = Fixture::new("next_invocation").await;
    fixture.manifest["configuration"]["schema"] = json!({
        "type":"object","additionalProperties":false,
        "properties":{"remote":{"type":"string"},"local":{"type":"string"}},
        "oneOf":[{"required":["remote"],"not":{"required":["local"]}},
                 {"required":["local"],"not":{"required":["remote"]}}]
    });
    fixture.manifest["configuration"]["defaults"] = json!({"local":"bundled-example"});
    fixture.write_manifest();
    let legacy = json!({"remote":"http://127.0.0.1/catalog"});
    fs::write(
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let view = fixture.store.get("demo").await.unwrap();
    assert!(view.compatible);
    assert_eq!(view.values, legacy);
    let path = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Fixture::raw(&path), legacy);
}

#[tokio::test]
async fn reload_policy_retains_applied_snapshot_and_upgrade_preserves_values_until_explicit_confirmation()
 {
    let mut fixture = Fixture::new("plugin_reload").await;
    let saved = fixture
        .store
        .patch("demo", 0, json!({"count":9}))
        .await
        .unwrap();
    assert!(saved.pending_reload);
    assert_eq!(saved.applied_revision, 0);
    let previous = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Fixture::raw(&previous)["count"], 2);
    assert!(matches!(
        fixture.store.mark_applied("demo", 0).await,
        Err(Error::Conflict(_))
    ));
    let applied = fixture.store.mark_applied("demo", 1).await.unwrap();
    assert!(!applied.pending_reload);
    let latest = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Fixture::raw(&latest)["count"], 9);
    assert_ne!(latest, previous);
    fixture.manifest["configuration"]["version"] = json!(2);
    fixture.manifest["version"] = json!("2.0.0");
    fixture.write_manifest();
    let incompatible = fixture.store.get("demo").await.unwrap();
    assert!(!incompatible.compatible);
    assert_eq!(incompatible.values["count"], 9);
    assert!(matches!(
        fixture.store.invocation_path("demo").await,
        Err(Error::Conflict(_))
    ));
    let confirmed = fixture.store.patch("demo", 1, json!({})).await.unwrap();
    assert!(confirmed.compatible);
    assert_eq!(confirmed.values["count"], 9);
    assert!(confirmed.pending_reload);
    assert_eq!(Fixture::raw(&latest)["count"], 9);
}

#[tokio::test]
async fn deployment_directory_includes_old_undeclared_plugins_without_exposing_legacy_secrets() {
    let mut fixture = Fixture::new("next_invocation").await;
    fixture
        .manifest
        .as_object_mut()
        .unwrap()
        .remove("configuration");
    fixture.manifest["args"] = json!([
        "--config",
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json")
    ]);
    fixture.write_manifest();
    let listed = fixture.store.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].definition.is_none());
    assert_eq!(listed[0].values, json!({}));
    assert!(matches!(
        fixture.store.patch("demo", 0, json!({})).await,
        Err(Error::Conflict(_))
    ));
    assert!(
        fixture
            .store
            .invocation_path("demo")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn references_branches_tuples_and_recursive_maps_share_masking_and_readonly_rules() {
    let mut fixture = Fixture::new("next_invocation").await;
    fs::remove_file(
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json"),
    )
    .unwrap();
    let defaults = json!({
        "secret":"reference-secret","identity":"fixed",
        "branch":{"mode":"a","secret":"branch-secret","identity":"branch-fixed"},
        "either":{"secret":"either-secret"},
        "map":{"PRIVATE_TOKEN":"map-secret","public":"visible"},
        "tuple":["tuple-secret","tuple-fixed"],
        "nested":{"token":"recursive-secret","child":{"token":"child-secret"}}
    });
    fixture.manifest["configuration"]["defaults"] = defaults.clone();
    fixture.manifest["configuration"]["schema"] = json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "type":"object","additionalProperties":false,
        "$defs":{
            "secret":{"type":"string","writeOnly":true,"default":"leaf-secret"},
            "fixed":{"type":"string","readOnly":true},
            "node":{"type":"object","properties":{
                "token":{"$ref":"#/$defs/secret"},"child":{"$ref":"#/$defs/node"}
            }}
        },
        "properties":{
            "secret":{"$ref":"#/$defs/secret"},
            "identity":{"allOf":[{"$ref":"#/$defs/fixed"}]},
            "branch":{"oneOf":[
                {"type":"object","properties":{"mode":{"const":"a"},"secret":{"$ref":"#/$defs/secret"},"identity":{"readOnly":true}}},
                {"type":"object","properties":{"mode":{"const":"b"},"secret":{"type":"string"},"identity":{"type":"string"}}}
            ]},
            "either":{"anyOf":[{"properties":{"secret":{"$ref":"#/$defs/secret"}}},{"type":"object"}]},
            "map":{"type":"object","patternProperties":{"^PRIVATE_":{"$ref":"#/$defs/secret"}},"additionalProperties":{"type":"string"}},
            "tuple":{"type":"array","prefixItems":[{"$ref":"#/$defs/secret"},{"$ref":"#/$defs/fixed"}],"items":false},
            "nested":{"$ref":"#/$defs/node"}
        },
        "default":defaults,"examples":[defaults]
    });
    fixture.write_manifest();
    let view = fixture.store.get("demo").await.unwrap();
    assert!(view.compatible);
    let rendered = serde_json::to_string(&view).unwrap();
    for secret in [
        "reference-secret",
        "branch-secret",
        "either-secret",
        "map-secret",
        "tuple-secret",
        "recursive-secret",
        "child-secret",
        "leaf-secret",
    ] {
        assert!(
            !rendered.contains(secret),
            "配置响应不得暴露模式中的敏感默认值"
        );
    }
    assert_eq!(view.values["map"]["public"], "visible");
    assert_eq!(
        view.definition.as_ref().unwrap().schema["default"]["secret"],
        "********"
    );
    let saved = fixture.store.patch("demo", 0, view.values).await.unwrap();
    assert!(saved.compatible);
    let snapshot = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    let raw = Fixture::raw(&snapshot);
    assert_eq!(raw["secret"], "reference-secret");
    assert_eq!(raw["branch"]["secret"], "branch-secret");
    assert_eq!(raw["tuple"][0], "tuple-secret");
    assert_eq!(raw["nested"]["child"]["token"], "child-secret");
    let rejected = fixture
        .store
        .patch(
            "demo",
            1,
            json!({
                "identity":"changed","branch":{"mode":"b","identity":"changed"},
                "tuple":["********","changed"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(rejected.revision, 1);
    for path in ["/identity", "/branch/identity", "/tuple/1"] {
        assert!(rejected.field_errors.iter().any(|error| error.path == path));
    }
    assert_eq!(Fixture::raw(&snapshot), raw);
    fixture.manifest["configuration"]["version"] = json!(2);
    fixture.manifest["configuration"]["schema"] =
        json!({"type":"object", "default": defaults, "examples":[defaults]});
    fixture.write_manifest();
    let upgraded = fixture.store.get("demo").await.unwrap();
    assert!(!upgraded.compatible);
    assert_eq!(upgraded.values["secret"], "********");
    assert_eq!(upgraded.values["nested"]["child"]["token"], "********");
    let upgraded = fixture
        .store
        .patch("demo", 1, upgraded.values)
        .await
        .unwrap();
    assert!(upgraded.compatible);
    let newest = fixture
        .store
        .invocation_path("demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Fixture::raw(&newest)["secret"], "reference-secret");
    assert_eq!(Fixture::raw(&newest)["tuple"][0], "tuple-secret");
    assert!(
        !serde_json::to_string(&upgraded)
            .unwrap()
            .contains("reference-secret")
    );
}

#[tokio::test]
async fn concurrent_cas_has_one_winner_and_incompatible_upgrade_keeps_saved_values_after_reopen() {
    let mut fixture = Fixture::new("next_invocation").await;
    let (left, right) = tokio::join!(
        fixture.store.patch("demo", 0, json!({"count":7})),
        fixture.store.patch("demo", 0, json!({"count":8}))
    );
    let (saved, conflict) = match (left, right) {
        (Ok(saved), Err(conflict)) | (Err(conflict), Ok(saved)) => (saved, conflict),
        _ => panic!("同一修订并发写入必须只有一个成功"),
    };
    assert!(matches!(conflict, Error::Conflict(_)));
    assert_eq!(saved.revision, 1);
    fixture.manifest["configuration"]["version"] = json!(2);
    fixture.manifest["configuration"]["schema"]["properties"]["count"]["maximum"] = json!(3);
    fixture.write_manifest();
    let original_count = saved.values["count"].clone();
    let root = fixture.directory.path().join("managed");
    let deployment = fixture.directory.path().join("plugins");
    drop(fixture.store);
    let reopened = FilePluginConfigurations::open(&root, &deployment)
        .await
        .unwrap();
    let incompatible = reopened.get("demo").await.unwrap();
    assert!(!incompatible.compatible);
    assert_eq!(incompatible.values["count"], original_count);
    assert_eq!(incompatible.revision, 1);
    let rejected = reopened.patch("demo", 1, json!({})).await.unwrap();
    assert!(!rejected.compatible);
    assert_eq!(rejected.revision, 1);
    assert_eq!(rejected.values["count"], original_count);
    assert!(matches!(
        reopened.invocation_path("demo").await,
        Err(Error::Conflict(_))
    ));
    let repaired = reopened.patch("demo", 1, json!({"count":3})).await.unwrap();
    assert!(repaired.compatible);
    assert_eq!(repaired.revision, 2);
    assert_eq!(repaired.values["count"], 3);
}

#[tokio::test]
async fn historical_revisions_migrate_without_changing_applied_values_or_source_files() {
    let fixture = Fixture::new("plugin_reload").await;
    fixture
        .store
        .patch("demo", 0, json!({"count":7}))
        .await
        .unwrap();
    let old_root = fixture.directory.path().join("managed");
    let source = fs::read(old_root.join("demo/state.json")).unwrap();
    let root = fixture
        .directory
        .path()
        .join("user/plugin-configurations/server");
    let deployment = fixture.directory.path().join("plugins");
    drop(fixture.store);
    let store =
        FilePluginConfigurations::open_with_legacy(&root, &deployment, vec![old_root.clone()])
            .await
            .unwrap();
    let view = store.get("demo").await.unwrap();
    assert_eq!(view.revision, 1);
    assert_eq!(view.applied_revision, 0);
    assert_eq!(view.values["count"], 7);
    let invocation = store.invocation_path("demo").await.unwrap().unwrap();
    assert_eq!(Fixture::raw(&invocation)["count"], 2);
    assert_eq!(fs::read(old_root.join("demo/state.json")).unwrap(), source);
    store.mark_applied("demo", 1).await.unwrap();
    assert_eq!(
        store
            .patch("demo", 1, json!({"count":8}))
            .await
            .unwrap()
            .revision,
        2
    );
    drop(store);
    let store =
        FilePluginConfigurations::open_with_legacy(&root, &deployment, vec![old_root.clone()])
            .await
            .unwrap();
    assert_eq!(store.get("demo").await.unwrap().values["count"], 8);
    assert_eq!(fs::read(old_root.join("demo/state.json")).unwrap(), source);
}

#[tokio::test]
async fn first_defaults_survive_relocation_and_updated_bundled_defaults() {
    let mut fixture = Fixture::new("next_invocation").await;
    fs::remove_file(
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json"),
    )
    .unwrap();
    assert_eq!(fixture.store.get("demo").await.unwrap().values["count"], 1);
    fixture.manifest["configuration"]["defaults"]["count"] = json!(9);
    fixture.write_manifest();
    assert_eq!(fixture.store.get("demo").await.unwrap().values["count"], 1);
    let root = fixture.directory.path().join("managed");
    let deployment = fixture.directory.path().join("other-deployment/demo");
    fs::create_dir_all(&deployment).unwrap();
    fs::write(
        deployment.join("manifest.json"),
        serde_json::to_vec(&fixture.manifest).unwrap(),
    )
    .unwrap();
    drop(fixture.store);
    let store = FilePluginConfigurations::open(&root, deployment.parent().unwrap())
        .await
        .unwrap();
    assert_eq!(store.get("demo").await.unwrap().values["count"], 1);
    assert!(
        store
            .invocation_path("demo")
            .await
            .unwrap()
            .unwrap()
            .starts_with(fs::canonicalize(root).unwrap())
    );
}
