use super::*;
use serde_json::json;

fn config() -> Config {
    let root = std::env::temp_dir().join("deviceforge-sdk-status-test");
    Config::parse(
        &serde_json::to_vec(&json!({
            "format_version":1,"profile":PROFILE,
            "node_executable":root.join("node"),"node_version":NODE_VERSION,
            "sdk_entry":root.join("sdk/dist/index.js"),"sdk_version":SDK_VERSION,
            "cli_executable":root.join("cli"),"cli_version":SDK_VERSION,
            "projects":{"demo":root.join("project")},"state_root":root.join("state"),
            "codex_home":root.join("provider"),"environment":{},"thread_options":{}
        }))
        .unwrap(),
    )
    .unwrap()
}

fn version(value: &str) -> probes::Version {
    probes::Version {
        version: Some(value.into()),
        scope_complete: true,
        cleanup_complete: true,
        reason: None,
    }
}

fn loaded() -> probes::Loaded {
    probes::Loaded {
        loaded: true,
        scope_complete: true,
        reason: None,
    }
}

#[test]
fn configuration_and_model_history_cannot_replace_actual_runtime_probes() {
    let config = config();
    let mut node = version(NODE_VERSION);
    node.version = None;
    node.scope_complete = false;
    let mut sdk = loaded();
    sdk.loaded = false;
    let status = aggregate(&config, &node, &version(SDK_VERSION), &sdk, Ok(true));
    assert!(status.configured);
    assert!(status.model_verified);
    assert!(status.node_version.is_none());
    assert!(!status.sdk_loaded);
    assert!(!status.process_scope_qualified);
    assert!(!status.ready);
}

#[test]
fn every_actual_scope_and_successful_private_sdk_probe_are_required() {
    let config = config();
    for missing in 0..3 {
        let mut node = version(NODE_VERSION);
        let mut cli = version(SDK_VERSION);
        let mut sdk = loaded();
        match missing {
            0 => node.scope_complete = false,
            1 => cli.scope_complete = false,
            _ => sdk.scope_complete = false,
        }
        let status = aggregate(&config, &node, &cli, &sdk, Ok(true));
        assert!(!status.process_scope_qualified);
        assert!(!status.ready);
    }
    for missing_cleanup in 0..2 {
        let mut node = version(NODE_VERSION);
        let mut cli = version(SDK_VERSION);
        if missing_cleanup == 0 {
            node.cleanup_complete = false;
        } else {
            cli.cleanup_complete = false;
        }
        let status = aggregate(&config, &node, &cli, &loaded(), Ok(true));
        assert!(!status.process_scope_qualified);
        assert!(!status.ready);
    }
    let status = aggregate(
        &config,
        &version(NODE_VERSION),
        &version(SDK_VERSION),
        &loaded(),
        Ok(false),
    );
    assert!(status.process_scope_qualified);
    assert!(!status.model_verified);
    assert!(!status.ready);
}

#[test]
fn ready_requires_actual_versions_and_readable_model_qualification() {
    let config = config();
    let node = version(NODE_VERSION);
    let cli = version(SDK_VERSION);
    let sdk = loaded();
    assert!(aggregate(&config, &node, &cli, &sdk, Ok(true)).ready);
    let mismatched = aggregate(&config, &version("24.13.0"), &cli, &sdk, Ok(true));
    assert_eq!(mismatched.node_version.as_deref(), Some("24.13.0"));
    assert!(!mismatched.ready);
    let broken = aggregate(&config, &node, &cli, &sdk, Err("资格记录损坏".into()));
    assert!(!broken.model_verified);
    assert!(!broken.ready);
    assert_eq!(broken.reason.as_deref(), Some("资格记录损坏"));
}

#[test]
fn version_parser_returns_only_bounded_version_fields() {
    assert_eq!(
        probes::parse_version(b"v24.14.0\n", true).unwrap(),
        NODE_VERSION
    );
    assert_eq!(
        probes::parse_version(b"codex-cli 0.162.1\r\n", false).unwrap(),
        SDK_VERSION
    );
    for bytes in [
        b"codex 0.162.1\n".as_slice(),
        b"codex-cli 0.162.1\nsecret".as_slice(),
        b"codex-cli 0.162.1\n\n".as_slice(),
        b"codex-cli 0.162.1 extra".as_slice(),
        b"codex-cli 0..1".as_slice(),
        b"codex-cli 024.14.0".as_slice(),
        b"codex-cli 999999999999999.0.1".as_slice(),
        b"\xff".as_slice(),
    ] {
        assert!(probes::parse_version(bytes, false).is_err());
    }
}
