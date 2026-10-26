use super::*;
use serde_json::json;

fn sample() -> DependencyManifest {
    serde_json::from_value(json!({"format_version":1,"dependencies":[{
        "id":"third-party-tool","name":"第三方工具","version_requirement":">=1.0.0, <2.0.0",
        "entries":["main"],"discovery":[{"kind":"environment","value":"THIRD_PARTY_HOME","entries":{"main":"bin/tool.exe"}}],
        "probe":{"entry":"main","args":["--version"],"pattern":"tool ([0-9]+\\.[0-9]+\\.[0-9]+)"},
        "bindings":[{"config_pointer":"/tools/main","entry":"main"}]
    }]})).unwrap()
}

#[test]
fn third_party_contract_and_version_probe_are_generic() {
    let manifest = sample();
    manifest.validate().unwrap();
    let probe = manifest.dependencies[0].probe.as_ref().unwrap();
    assert_eq!(probe_version(probe, "tool 1.2.3\r\n"), Some("1.2.3".into()));
    assert!(compatible_version(">=1.0.0, <2.0.0", "1.2.3"));
    assert!(!compatible_version(">=1.0.0, <2.0.0", "2.0.0"));
    assert!(compatible_version("=5.0.0.71", "5.0.0.71"));
    assert!(!compatible_version("=5.0.0.71", "5.0.0.72"));
}

#[test]
fn rejects_traversal_cycles_and_unbounded_probes() {
    let mut manifest = sample();
    manifest.dependencies[0].discovery[0].value = "../../logs".into();
    manifest.dependencies[0].discovery[0].kind = DiscoveryKind::UserDirectory;
    assert!(manifest.validate().is_err());
    let mut manifest = sample();
    manifest.dependencies[0]
        .requires
        .push("third-party-tool".into());
    assert!(manifest.validate().is_err());
    let mut manifest = sample();
    manifest.dependencies[0].probe.as_mut().unwrap().timeout_ms = 0;
    assert!(manifest.validate().is_err());
    assert!(DependencyManifest::default().validate().is_ok());
}

#[test]
fn dependency_identity_matches_public_management_routes() {
    for id in ["7zip", "third-party.tool_1"] {
        let mut manifest = sample();
        manifest.dependencies[0].id = id.into();
        manifest.validate().unwrap();
    }
    for id in ["Uppercase", "builtin.reserved", "../tool"] {
        let mut manifest = sample();
        manifest.dependencies[0].id = id.into();
        assert!(manifest.validate().is_err());
    }
    let mut manifest = sample();
    manifest.dependencies[0].id = "a".repeat(100);
    assert!(manifest.validate().is_err());
}
