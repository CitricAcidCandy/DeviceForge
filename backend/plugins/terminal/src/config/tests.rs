use super::*;
use serde_json::{Value, json};

fn raw(profile: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"format_version":1,"profiles":{"tool":profile}})).unwrap()
}

fn profile() -> serde_json::Value {
    json!({"executable":"node","args":["--version"],"resource_scope":"direct_process"})
}

#[test]
fn configured_profile_preserves_fixed_argv_without_shell_splitting() {
    let mut value = profile();
    value["args"] = json!(["", "a b", "'$HOME'", "%s", "设备"]);
    let config = Config::parse(&raw(value)).unwrap();
    let profile = config.profile("tool").unwrap();
    assert_eq!(profile.executable, "node");
    assert_eq!(profile.args, ["", "a b", "'$HOME'", "%s", "设备"]);
    assert!(config.profile("missing").is_err());
}

#[test]
fn invalid_program_arguments_resource_scope_and_unknown_fields_are_rejected() {
    for field in ["shell", "environment", "secret"] {
        let mut value = profile();
        value[field] = json!("not accepted");
        assert!(Config::parse(&raw(value)).is_err());
    }
    for executable in ["", "node --version", "./node", "../node", "-flag", "node\n"] {
        let mut value = profile();
        value["executable"] = json!(executable);
        assert!(Config::parse(&raw(value)).is_err());
    }
    for args in [
        json!(["a\0b"]),
        json!(["a\nb"]),
        json!(["a".repeat(4097)]),
        json!(vec!["x"; 65]),
        json!(vec!["a".repeat(4096); 5]),
    ] {
        let mut value = profile();
        value["args"] = args;
        assert!(Config::parse(&raw(value)).is_err());
    }
    for scope in [
        Value::Null,
        json!(true),
        json!("all_resources"),
        json!("process_tree"),
    ] {
        let mut value = profile();
        value["resource_scope"] = scope;
        assert!(Config::parse(&raw(value)).is_err());
    }
}

#[test]
fn duplicate_profiles_limit_version_and_config_bytes_are_strict() {
    let duplicate = br#"{"format_version":1,"profiles":{"tool":{"executable":"node","args":[],"resource_scope":"direct_process"},"tool":{"executable":"other","args":[],"resource_scope":"direct_process"}}}"#;
    assert!(Config::parse(duplicate).is_err());
    let profiles = (0..33)
        .map(|index| (format!("tool{index}"), profile()))
        .collect::<serde_json::Map<_, _>>();
    assert!(
        Config::parse(
            &serde_json::to_vec(&json!({"format_version":1,"profiles":profiles})).unwrap()
        )
        .is_err()
    );
    for value in [
        json!({"format_version":2,"profiles":{"tool":profile()}}),
        json!({"format_version":1,"profiles":{}}),
        json!({"format_version":1,"profiles":{"../tool":profile()}}),
    ] {
        assert!(Config::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    assert!(Config::parse(&vec![b' '; CONFIG_LIMIT + 1]).is_err());
}

#[test]
fn deployment_cli_only_accepts_absolute_config_and_default_sidecar() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("terminal.exe");
    assert_eq!(
        reading::path(&[], executable.clone()).unwrap(),
        root.path().join("terminal.config.json")
    );
    let configured = root.path().join("config.json");
    assert_eq!(
        reading::path(
            &["--config".into(), configured.as_os_str().into()],
            executable.clone()
        )
        .unwrap(),
        configured
    );
    for args in [
        vec!["--config".into()],
        vec!["--config".into(), "relative.json".into()],
        vec!["--tool".into(), "node".into()],
        vec![
            "--config".into(),
            root.path().join("..").join("config.json").into_os_string(),
        ],
    ] {
        assert!(reading::path(&args, executable.clone()).is_err());
    }
}
