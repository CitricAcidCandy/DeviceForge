//! 资源绑定覆盖默认入口，保留用户原值与显式绝对路径。
use apk_domain::{
    plugin_configurations::PluginConfigurationStore,
    plugin_installations::{BoundTool, ResourceBinding, ResourceBindings},
};
use apk_infrastructure::plugin_configurations::FilePluginConfigurations;
use apk_plugin_sdk::resources::ManagedResources;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

struct TaggedFixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    schema: Value,
    store: Arc<FilePluginConfigurations>,
}

impl TaggedFixture {
    async fn new(manifest: &str, pointers: &[&str], values: Option<Value>) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("user/plugin-configurations/server");
        let managed = temporary.path().join("user/plugins");
        let directory = managed.join("third-party");
        let revision = "b".repeat(64);
        let snapshot = directory.join("revisions").join(&revision);
        fs::create_dir_all(&snapshot).unwrap();
        let configuration =
            serde_json::from_str::<Value>(manifest).unwrap()["configuration"].clone();
        let schema = configuration["schema"].clone();
        let executable = std::env::current_exe().unwrap();
        let manifest = json!({"id":"third-party","version":"1","protocol_version":1,
            "executable":executable,"args":[],"operations":[],"configuration":configuration});
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut tools = BTreeMap::new();
        let mut bindings = Vec::new();
        for (index, pointer) in pointers.iter().enumerate() {
            let tool_id = format!("entry-{index}");
            tools.insert(
                tool_id.clone(),
                BoundTool {
                    version: "1".into(),
                    platform: "windows-x86_64".into(),
                    entries: BTreeMap::from([("main".into(), executable.to_str().unwrap().into())]),
                },
            );
            bindings.push(ResourceBinding {
                tool_id,
                component_id: "third-party".into(),
                config_pointer: (*pointer).into(),
                entry: "main".into(),
            });
        }
        let resources = ResourceBindings {
            format_version: 1,
            release_id: "third-party".into(),
            revision,
            tools,
            bindings,
        };
        for path in [
            directory.join("resources.json"),
            snapshot.join("resources.json"),
        ] {
            fs::write(path, serde_json::to_vec(&resources).unwrap()).unwrap();
        }
        let store = FilePluginConfigurations::open(&root, &managed)
            .await
            .unwrap();
        store.get("third-party").await.unwrap();
        if let Some(values) = values {
            // 模拟已保存的旧状态；不经编辑接口补齐或覆盖用户数据。
            let state_path = root.join("third-party/state.json");
            let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
            state["values"] = values.clone();
            fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
            fs::write(
                root.join("third-party/0.json"),
                serde_json::to_vec(&values).unwrap(),
            )
            .unwrap();
        }
        Self {
            _temporary: temporary,
            root,
            schema,
            store,
        }
    }

    async fn effective_preserving_state(&self) -> Value {
        let state_path = self.root.join("third-party/state.json");
        let revision_path = self.root.join("third-party/0.json");
        let state = fs::read(&state_path).unwrap();
        let revision = fs::read(&revision_path).unwrap();
        let path = self
            .store
            .invocation_path("third-party")
            .await
            .unwrap()
            .unwrap();
        let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(jsonschema::is_valid(&self.schema, &effective));
        assert_eq!(fs::read(state_path).unwrap(), state);
        assert_eq!(fs::read(revision_path).unwrap(), revision);
        assert_eq!(self.store.get("third-party").await.unwrap().revision, 0);
        effective
    }
}

const ANDROID_DEVICE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugins/android-device/manifest.json"
));
const ANDROID_PACKAGES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugins/android-packages/manifest.json"
));

#[tokio::test]
async fn real_tagged_tool_schemas_overlay_empty_saved_tools_without_mutating_revisions() {
    for (manifest, pointers) in [
        (ANDROID_DEVICE, vec!["/tools/bundletool/jar"]),
        (
            ANDROID_PACKAGES,
            vec![
                "/tools/apkanalyzer/executable",
                "/tools/apksigner/jar",
                "/tools/bundletool/jar",
                "/tools/apktool/jar",
            ],
        ),
    ] {
        let original =
            serde_json::from_str::<Value>(manifest).unwrap()["configuration"]["defaults"].clone();
        let fixture = TaggedFixture::new(manifest, &pointers, Some(original.clone())).await;
        let effective = fixture.effective_preserving_state().await;
        for pointer in pointers {
            let parent = pointer.rsplit_once('/').unwrap().0;
            let kind = if pointer.ends_with("/executable") {
                "executable"
            } else {
                "java_jar"
            };
            assert_eq!(
                effective.pointer(&format!("{parent}/kind")),
                Some(&json!(kind))
            );
            assert_eq!(
                effective.pointer(pointer),
                Some(&json!(std::env::current_exe().unwrap()))
            );
            assert!(original.pointer(parent).is_none());
        }
    }
}

#[tokio::test]
async fn explicit_absolute_relative_paths_and_selected_kind_remain_user_owned() {
    let absolute = std::env::current_exe().unwrap();
    for executable in [
        absolute.to_string_lossy().into_owned(),
        "custom/apkanalyzer".into(),
    ] {
        let values = json!({"format_version":1,"tools":{
            "apkanalyzer":{"kind":"executable","executable":executable},
            "apksigner":{"kind":"executable","executable":"user-apksigner"}
        }});
        let fixture = TaggedFixture::new(
            ANDROID_PACKAGES,
            &["/tools/apkanalyzer/executable"],
            Some(values.clone()),
        )
        .await;
        assert_eq!(fixture.effective_preserving_state().await, values);
    }
    let values = json!({"format_version":1,"tools":{
        "bundletool":{"kind":"java_jar","jar":absolute}
    }});
    let fixture = TaggedFixture::new(
        ANDROID_DEVICE,
        &["/tools/bundletool/jar"],
        Some(values.clone()),
    )
    .await;
    assert_eq!(fixture.effective_preserving_state().await, values);
}

#[tokio::test]
async fn managed_jar_binding_rejects_existing_executable_kind_without_publishing_snapshot() {
    let values = json!({"format_version":1,"tools":{
        "apksigner":{"kind":"executable","executable":"user-apksigner"}
    }});
    let fixture =
        TaggedFixture::new(ANDROID_PACKAGES, &["/tools/apksigner/jar"], Some(values)).await;
    let directory = fixture.root.join("third-party");
    let state = fs::read(directory.join("state.json")).unwrap();
    let revision = fs::read(directory.join("0.json")).unwrap();
    assert!(matches!(
        fixture.store.invocation_path("third-party").await,
        Err(apk_domain::Error::Invalid(message)) if message.contains("不匹配")
    ));
    assert_eq!(fs::read(directory.join("state.json")).unwrap(), state);
    assert_eq!(fs::read(directory.join("0.json")).unwrap(), revision);
    assert!(!fs::read_dir(directory).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("effective-")
    }));
}

#[tokio::test]
async fn dictionary_bindings_validate_only_after_all_entries_and_keep_unconfigured_business_fields()
{
    let schema = json!({"type":"object","properties":{
        "tools":{"type":"object","additionalProperties":{"type":"string"},"oneOf":[
            {"maxProperties":0},
            {"required":["first","second"]}
        ]},
        "project":{"type":["string","null"]}
    },"required":["tools","project"]});
    let values = json!({"tools":{},"project":null});
    assert!(jsonschema::is_valid(&schema, &values));
    assert!(!jsonschema::is_valid(
        &schema,
        &json!({"tools":{"first":"managed"},"project":null})
    ));
    let manifest = json!({"configuration":{"version":1,"apply_policy":"next_invocation",
        "schema":schema,"defaults":values}})
    .to_string();
    let fixture =
        TaggedFixture::new(&manifest, &["/tools/first", "/tools/second"], Some(values)).await;
    let effective = fixture.effective_preserving_state().await;
    assert_eq!(effective["project"], Value::Null);
    assert_eq!(
        effective["tools"]["first"],
        json!(std::env::current_exe().unwrap())
    );
    assert_eq!(effective["tools"]["second"], effective["tools"]["first"]);
}

#[tokio::test]
async fn managed_roots_and_effective_binding_preserve_original_configuration() {
    let temporary = tempfile::tempdir().unwrap();
    let deployment = temporary.path().join("shipped");
    let managed = temporary.path().join("user/plugins");
    let directory = managed.join("third-party");
    let revision = "a".repeat(64);
    let snapshot = directory.join("revisions").join(&revision);
    fs::create_dir_all(&deployment).unwrap();
    fs::create_dir_all(&snapshot).unwrap();
    let executable = std::env::current_exe().unwrap();
    let manifest = json!({"id":"third-party","version":"1","protocol_version":1,
    "executable":executable,"args":[],"operations":[],"configuration":{
        "version":1,"apply_policy":"next_invocation",
        "schema":{"type":"object","properties":{"tools":{"type":"object","properties":{"runner":{"type":"string"}},"required":["runner"]}},"required":["tools"]},
        "defaults":{"tools":{"runner":"runner"}}
    }});
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let bindings = ResourceBindings {
        format_version: 1,
        release_id: "third-party".into(),
        revision: revision.clone(),
        tools: BTreeMap::from([(
            "runner".into(),
            BoundTool {
                version: "2".into(),
                platform: "windows-x86_64".into(),
                entries: BTreeMap::from([("main".into(), executable.to_str().unwrap().into())]),
            },
        )]),
        bindings: vec![ResourceBinding {
            tool_id: "runner".into(),
            component_id: "third-party".into(),
            config_pointer: "/tools/runner".into(),
            entry: "main".into(),
        }],
    };
    for path in [
        directory.join("resources.json"),
        snapshot.join("resources.json"),
    ] {
        fs::write(&path, serde_json::to_vec(&bindings).unwrap()).unwrap();
        // 使用宿主真实类型写入，再由公开 SDK 读取，避免双份契约字段漂移。
        let resources = ManagedResources::read(&path).unwrap();
        assert_eq!(resources.tools["runner"].platform, "windows-x86_64");
        assert_eq!(resources.entry("runner", "main").unwrap(), executable);
    }
    let root = temporary.path().join("user/plugin-configurations/server");
    let store =
        FilePluginConfigurations::open_with_deployments(&root, vec![managed, deployment], vec![])
            .await
            .unwrap();
    assert_eq!(store.list().await.unwrap().len(), 1);
    let config = store.get("third-party").await.unwrap();
    assert_eq!(config.values["tools"]["runner"], "runner");
    let path = store.invocation_path("third-party").await.unwrap().unwrap();
    let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(
        effective["tools"]["runner"],
        executable.to_string_lossy().as_ref()
    );
    let raw: Value =
        serde_json::from_slice(&fs::read(root.join("third-party/0.json")).unwrap()).unwrap();
    assert_eq!(raw["tools"]["runner"], "runner");
    let custom = temporary.path().join("custom.exe");
    store
        .patch("third-party", 0, json!({"tools":{"runner":custom}}))
        .await
        .unwrap();
    let path = store.invocation_path("third-party").await.unwrap().unwrap();
    let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(
        effective["tools"]["runner"],
        custom.to_string_lossy().as_ref()
    );
    assert_eq!(
        store.resources_path("third-party").await.unwrap(),
        Some(fs::canonicalize(snapshot.join("resources.json")).unwrap())
    );
    store
        .patch(
            "third-party",
            1,
            json!({"tools":{"runner":"custom-relative/runner.exe"}}),
        )
        .await
        .unwrap();
    let path = store.invocation_path("third-party").await.unwrap().unwrap();
    let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(effective["tools"]["runner"], "custom-relative/runner.exe");
}
