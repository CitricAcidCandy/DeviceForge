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
