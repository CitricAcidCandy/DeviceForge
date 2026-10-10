//! 通过公开 SDK 解析与实际提供者构造验证声明兼容，不启动任何进程。

use super::support::declaration;
use apk_domain::{Error, Executor};
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::Manifest;
use serde_json::{Value, json};
use std::time::Duration;

#[test]
fn omitted_and_null_budgets_keep_thirty_seconds_in_both_device_api_versions() {
    let directory = tempfile::tempdir().unwrap();
    for api in [1, 2] {
        for timeout in [None, Some(Value::Null)] {
            let manifest: Manifest =
                serde_json::from_value(declaration(2, api, timeout, directory.path())).unwrap();
            assert_eq!(
                manifest.devices.as_ref().unwrap().capabilities[0].execution_timeout_ms,
                None
            );
            let plugin = ProcessPlugin::new(manifest).unwrap();
            let definition = plugin.device_provider().unwrap();
            assert_eq!(definition.api_version, api);
            assert_eq!(
                definition.capabilities[0].execution_timeout(),
                Duration::from_secs(30)
            );
        }
    }
    assert!(!directory.path().join("started.json").exists());
}

#[test]
fn version_two_accepts_both_inclusive_budget_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    for protocol in [2, 3] {
        for timeout in [1, 120000] {
            let manifest: Manifest = serde_json::from_value(declaration(
                protocol,
                2,
                Some(json!(timeout)),
                directory.path(),
            ))
            .unwrap();
            let plugin = ProcessPlugin::new(manifest).unwrap();
            assert_eq!(
                plugin.device_provider().unwrap().capabilities[0].execution_timeout(),
                Duration::from_millis(timeout)
            );
        }
    }
}

#[test]
fn version_one_rejects_explicit_budgets_and_version_two_rejects_out_of_range() {
    let directory = tempfile::tempdir().unwrap();
    for (api, timeout) in [
        (1, 1),
        (1, 30000),
        (1, 120000),
        (2, 0),
        (2, 120001),
        (2, u64::MAX),
    ] {
        let manifest: Manifest =
            serde_json::from_value(declaration(2, api, Some(json!(timeout)), directory.path()))
                .unwrap();
        assert!(
            matches!(ProcessPlugin::new(manifest), Err(Error::Invalid(_))),
            "API {api}，预算 {timeout} 必须精确为输入无效"
        );
    }
    assert!(!directory.path().join("started.json").exists());
}

#[test]
fn budget_is_an_optional_unsigned_integer_without_coercion() {
    let directory = tempfile::tempdir().unwrap();
    for timeout in [
        json!(-1),
        json!(1.5),
        json!("30000"),
        json!(true),
        json!([]),
        json!({}),
    ] {
        assert!(
            serde_json::from_value::<Manifest>(declaration(2, 2, Some(timeout), directory.path()))
                .is_err()
        );
    }
    assert!(!directory.path().join("started.json").exists());
}

#[test]
fn unsupported_device_api_versions_are_invalid() {
    let directory = tempfile::tempdir().unwrap();
    for api in [0, 4] {
        let manifest: Manifest =
            serde_json::from_value(declaration(2, api, None, directory.path())).unwrap();
        assert!(matches!(
            ProcessPlugin::new(manifest),
            Err(Error::Invalid(_))
        ));
    }
}
