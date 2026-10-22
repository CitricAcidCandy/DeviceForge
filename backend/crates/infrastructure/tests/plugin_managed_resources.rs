//! 资源绑定覆盖默认入口，保留用户原值与显式绝对路径。
use apk_domain::plugin_configurations::PluginConfigurationStore;
use apk_infrastructure::plugin_configurations::FilePluginConfigurations;
use serde_json::{Value, json};
use std::fs;

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
    fs::write(directory.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    let bindings = json!({"format_version":1,"release_id":"third-party","revision":revision,
        "tools":{"runner":{"version":"2","entries":{"main":executable}}},
        "bindings":[{"tool_id":"runner","component_id":"third-party","config_pointer":"/tools/runner","entry":"main"}]});
    for path in [directory.join("resources.json"), snapshot.join("resources.json")] {
        fs::write(path, serde_json::to_vec(&bindings).unwrap()).unwrap();
    }
    let root = temporary.path().join("user/plugin-configurations/server");
    let store = FilePluginConfigurations::open_with_deployments(&root, vec![managed,deployment],vec![]).await.unwrap();
    assert_eq!(store.list().await.unwrap().len(),1);
    let config = store.get("third-party").await.unwrap();
    assert_eq!(config.values["tools"]["runner"], "runner");
    let path = store.invocation_path("third-party").await.unwrap().unwrap();
    let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(effective["tools"]["runner"], executable.to_string_lossy().as_ref());
    let raw: Value = serde_json::from_slice(&fs::read(root.join("third-party/0.json")).unwrap()).unwrap();
    assert_eq!(raw["tools"]["runner"], "runner");
    let custom = temporary.path().join("custom.exe");
    store.patch("third-party",0,json!({"tools":{"runner":custom}})).await.unwrap();
    let path = store.invocation_path("third-party").await.unwrap().unwrap();
    let effective: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(effective["tools"]["runner"],custom.to_string_lossy().as_ref());
    assert_eq!(store.resources_path("third-party").await.unwrap(),Some(snapshot.join("resources.json")));
}
