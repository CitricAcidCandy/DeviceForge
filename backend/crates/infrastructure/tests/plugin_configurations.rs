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
async fn legacy_is_read_only_until_first_save_then_cas_and_masked_merge_control_managed_snapshots()
{
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
    assert!(
        fixture
            .store
            .invocation_path("demo")
            .await
            .unwrap()
            .is_none()
    );
    fs::write(
        fixture
            .directory
            .path()
            .join("plugins/demo/bin/legacy.json"),
        br#"{"count":3,"token":"changed-secret","environment":{"PRIVATE":"changed-map-secret"}}"#,
    )
    .unwrap();
    assert_eq!(fixture.store.get("demo").await.unwrap().values["count"], 3);
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
    assert_eq!(raw["token"], "changed-secret");
    assert_eq!(raw["environment"]["PRIVATE"], "changed-map-secret");
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
