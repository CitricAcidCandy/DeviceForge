use super::*;
use apk_plugin_sdk::{ArtifactContext, ArtifactInput, Request};

fn request() -> Request {
    Request {
        protocol_version: 4,
        request_id: "harmony-validation".into(),
        operation: "app.install".into(),
        input: serde_json::Value::Null,
        artifacts: Some(ArtifactContext {
            inputs: vec![ArtifactInput {
                field: "/input/artifact_id".into(),
                artifact_id: "d0da1b1b-919c-40a8-9c71-fbb56614e488".into(),
                filename: "示例.HAP".into(),
                size: 10,
                sha256: "0".repeat(64),
                path: "unused-before-configuration".into(),
            }],
            output_directory: None,
        }),
    }
}

fn install() -> Input {
    Input::Install {
        device_id: "serial".into(),
        artifact_id: "d0da1b1b-919c-40a8-9c71-fbb56614e488".into(),
    }
}

#[test]
fn installation_requires_unique_nested_artifact_authorization() {
    assert!(validate_context(&request(), &install()).is_ok());
    for field in ["artifact_id", "/other/artifact_id"] {
        let mut value = request();
        value.artifacts.as_mut().unwrap().inputs[0].field = field.into();
        assert!(validate_context(&value, &install()).is_err());
    }
    let mut value = request();
    let artifacts = value.artifacts.as_mut().unwrap();
    artifacts.inputs.push(artifacts.inputs[0].clone());
    assert!(validate_context(&value, &install()).is_err());
}

#[test]
fn installation_rejects_non_hap_or_bad_metadata_before_io() {
    let mut value = request();
    value.artifacts.as_mut().unwrap().inputs[0].filename = "package.apk".into();
    assert!(validate_context(&value, &install()).is_err());
    let mut value = request();
    value.artifacts.as_mut().unwrap().inputs[0].size = FILE_LIMIT + 1;
    assert!(validate_context(&value, &install()).is_err());
    let mut value = request();
    value.artifacts.as_mut().unwrap().inputs[0].sha256 = "bad".into();
    assert!(validate_context(&value, &install()).is_err());
}

#[test]
fn non_install_actions_reject_artifact_inputs() {
    let input = Input::Packages {
        device_id: "serial".into(),
    };
    assert!(validate_context(&request(), &input).is_err());
    let mut empty = request();
    empty.artifacts.as_mut().unwrap().inputs.clear();
    assert!(validate_context(&empty, &input).is_ok());
}
