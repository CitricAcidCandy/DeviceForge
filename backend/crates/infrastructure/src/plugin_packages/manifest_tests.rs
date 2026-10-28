//! 新脚本包允许先部署待依赖文件，实际启动必须通过统一资源快照解析运行时。
use super::*;
use serde_json::json;

fn fixture(root: &Path, required: bool) {
    fs::write(root.join("script.py"), b"print('example')").unwrap();
    fs::write(
        root.join("package.json"),
        serde_json::to_vec(&json!({
        "version":"1.0.0", "deviceforge":{"kind":"server","manifest":"plugin.json",
        "entrypoints":{"any":{"runtime":"script","path":"script.py",
            "dependency":{"id":"third-party-interpreter","entry":"main"}}}}}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(&json!({
        "id":"script-test","version":"1.0.0","protocol_version":1,
        "operations":[{"name":"echo","title":"回显","input_schema":{"type":"object"}}]}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("dependencies.json"),
        serde_json::to_vec(&json!({
        "format_version":1,"dependencies":[{"id":"third-party-interpreter","name":"第三方解释器",
        "version_requirement":"*","required":required,"entries":["main"]}]}))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn script_package_maps_deferred_runtime_without_installed_node_or_machine_path() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    fixture(&root, true);
    let (package, operations) = validate(&root, &root, PackageKind::Server, None).unwrap();
    assert_eq!(package.runtime, "script");
    assert_eq!(operations.len(), 1);
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".deviceforge-runtime.json")).unwrap()).unwrap();
    assert_eq!(
        marker,
        json!({"format_version":1,"dependency":{"id":"third-party-interpreter","entry":"main"}})
    );
    let manifest: Manifest = paths::json(&root, "manifest.json").unwrap();
    assert!(manifest.executable.ends_with("script.py"));
    assert!(manifest.args[0].ends_with("script.py"));
}

#[test]
fn script_runtime_must_be_a_declared_required_dependency() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    fixture(&root, false);
    for declared in [true, false] {
        if !declared {
            fs::remove_file(root.join("dependencies.json")).unwrap();
        }
        let error = match validate(&root, &root, PackageKind::Server, None) {
            Ok(_) => panic!("未声明必需解释器的脚本包不应通过"),
            Err(error) => error,
        };
        assert!(matches!(error, Error::Invalid(_)));
        assert!(error.to_string().contains("脚本运行时"), "{error}");
    }
}

#[test]
fn browser_configuration_accepts_missing_policy_and_required_inputs_but_rejects_bad_defaults() {
    let temporary = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temporary.path()).unwrap();
    fs::write(root.join("index.js"), b"export default {panels:[]};").unwrap();
    fs::write(
        root.join("package.json"),
        serde_json::to_vec(&json!({"version":"1.0.0", "deviceforge":{
            "kind":"browser","manifest":"plugin.json", "entrypoints":{
                "any":{"runtime":"browser","path":"index.js"}}}}))
        .unwrap(),
    )
    .unwrap();
    let valid = json!({"version":1,"apply_policy":"next_invocation",
        "schema":{"type":"object","properties":{"endpoint":{"type":"string"}},
            "additionalProperties":false},"defaults":{}});
    let mut missing_policy = valid.clone();
    missing_policy
        .as_object_mut()
        .unwrap()
        .remove("apply_policy");
    let mut missing_default = valid.clone();
    missing_default["schema"]["required"] = json!(["endpoint"]);
    let mut invalid_default = valid.clone();
    invalid_default["defaults"] = json!({"endpoint":42});
    let mut invalid_policy = valid.clone();
    invalid_policy["apply_policy"] = json!("unknown");
    for (configuration, expected_error) in [
        (missing_policy, None),
        (missing_default, None),
        (invalid_policy, Some("包清单结构无效")),
        (invalid_default, Some("配置默认值不符合声明模式")),
        (valid, None),
    ] {
        fs::write(
            root.join("plugin.json"),
            serde_json::to_vec(&json!({"id":"configured_browser","version":"1.0.0",
                "api_version":2,"configuration":configuration}))
            .unwrap(),
        )
        .unwrap();
        let result = validate(&root, &root, PackageKind::Browser, None);
        if let Some(message) = expected_error {
            assert!(matches!(result, Err(Error::Invalid(error)) if error == message));
        } else {
            let (package, _) = result.unwrap();
            assert_eq!(package.id, "configured_browser");
        }
    }
}
