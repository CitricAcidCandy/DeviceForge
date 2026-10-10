use crate::support::{
    self, Fixture,
    artifacts::{self, ARTIFACT_ID, FILE_LIMIT},
    failure, success,
};
use serde_json::{Value, json};
use std::{fs, time::Duration};

fn reject(fixture: &Fixture, request: Value, expected: &str, scratch: &std::path::Path) {
    fs::write(&fixture.config_path, b"invalid-json-before-configuration").unwrap();
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    failure(&running.complete(), expected);
    fixture.assert_no_tool();
    artifacts::empty(scratch);
    assert!(!fixture.root.join("unused-output").exists());
}

#[test]
fn installation_rejects_missing_extra_and_duplicate_rows_before_configuration_or_io() {
    for shape in 0..5 {
        let mut fixture = Fixture::new("install-unique-row");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"authorized source");
        let row = request["artifacts"]["inputs"][0].clone();
        match shape {
            0 => {
                request.as_object_mut().unwrap().remove("artifacts");
            }
            1 => request["artifacts"] = Value::Null,
            2 => request["artifacts"]["inputs"] = json!([]),
            3 => request["artifacts"]["inputs"] = json!([row.clone(), row]),
            _ => {
                request["artifacts"]["inputs"] = json!([row,{"field":"/other","artifact_id":"other","filename":"other.apk","size":0,"sha256":"0".repeat(64),"path":"missing"}])
            }
        }
        reject(
            &fixture,
            request,
            "输入无效：安装要求唯一输入产物副本",
            &scratch,
        );
    }
}

#[test]
fn installation_requires_exact_nested_pointer_and_same_id_before_configuration_or_io() {
    for (field, id) in [
        ("artifact_id", ARTIFACT_ID),
        ("/artifact_id", ARTIFACT_ID),
        ("/input/artifact_id/", ARTIFACT_ID),
        ("/input/artifact_id", "ffffffff-ffff-ffff-ffff-ffffffffffff"),
        ("/input/artifact_id", "D0DA1B1B-919C-40A8-9C71-FBB56614E488"),
    ] {
        let mut fixture = Fixture::new("install-pointer-id");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"authorized source");
        request["artifacts"]["inputs"][0]["field"] = json!(field);
        request["artifacts"]["inputs"][0]["artifact_id"] = json!(id);
        request["artifacts"]["inputs"][0]["path"] = json!(fixture.root.join("never-read.apk"));
        reject(
            &fixture,
            request,
            "输入无效：安装输入产物pointer或ID不一致",
            &scratch,
        );
    }
}

#[test]
fn installation_uuid_is_exact_36_byte_hyphenated_hex_before_configuration() {
    for id in [
        "",
        "d0da1b1b919c40a89c71fbb56614e488",
        "{d0da1b1b-919c-40a8-9c71-fbb56614e488}",
        "d0da1b1b-919c-40a8-9c71-fbb56614e48g",
        "d0da1b1b_919c-40a8-9c71-fbb56614e488",
    ] {
        let mut fixture = Fixture::new("install-uuid");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"source");
        request["input"]["input"]["artifact_id"] = json!(id);
        reject(
            &fixture,
            request,
            "输入无效：产物ID须为标准连字符UUID",
            &scratch,
        );
    }
}

#[test]
fn installation_metadata_rejects_filename_extension_size_and_hash_before_configuration() {
    for (key, value, expected) in [
        (
            "filename",
            json!("../package.apk"),
            "输入无效：产物显示名不是有效单文件名",
        ),
        (
            "filename",
            json!("package.hap"),
            "输入无效：安装仅接受APK产物",
        ),
        ("size", json!(FILE_LIMIT + 1), "数据超过插件限额"),
        (
            "sha256",
            json!("0".repeat(63)),
            "输入无效：输入产物摘要无效",
        ),
        (
            "sha256",
            json!(format!("{}g", "0".repeat(63))),
            "输入无效：输入产物摘要无效",
        ),
    ] {
        let mut fixture = Fixture::new("install-metadata");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"source");
        request["artifacts"]["inputs"][0][key] = value;
        reject(&fixture, request, expected, &scratch);
    }
}

#[test]
fn installation_and_screenshot_business_fields_remain_strict() {
    for (operation, input) in [
        (
            "app.install",
            json!({"artifact_id":ARTIFACT_ID,"path":"supplied-by-business.apk"}),
        ),
        (
            "app.install",
            json!({"artifact_id":ARTIFACT_ID,"adb":"other"}),
        ),
        ("screenshot", json!({"output_directory":"business-output"})),
    ] {
        let mut fixture = Fixture::new("artifact-business-fields");
        let scratch = artifacts::configure_scratch(&mut fixture);
        reject(
            &fixture,
            fixture.request(operation, support::device(input)),
            "输入无效：设备动作封套或业务字段不符合严格格式",
            &scratch,
        );
    }
}

#[test]
fn screenshot_requires_output_authorization_and_rejects_any_input_before_configuration() {
    for shape in 0..3 {
        let mut fixture = Fixture::new("screenshot-authorization");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = fixture.request("screenshot", support::device(json!({})));
        let expected = if shape == 2 {
            request["artifacts"]["inputs"] = json!([artifacts::input_row(
                &fixture.root.join("never-read.apk"),
                b""
            )]);
            "输入无效：该设备动作不接受输入产物"
        } else {
            if shape == 0 {
                request.as_object_mut().unwrap().remove("artifacts");
            } else {
                request["artifacts"]["output_directory"] = Value::Null;
            }
            "输入无效：截图缺少宿主输出授权"
        };
        reject(&fixture, request, expected, &scratch);
    }
}

#[test]
fn legal_scratch_root_and_null_remain_noop_for_old_actions() {
    for configured in [false, true] {
        let mut fixture = Fixture::new("old-action-scratch");
        let scratch = artifacts::configure_scratch(&mut fixture);
        if !configured {
            fixture.config["scratch_root"] = Value::Null;
            fixture.save_config();
        }
        let reply = fixture.run("packages", support::device(json!({})), &[b""]);
        assert_eq!(success(&reply), &json!({"output":""}));
        artifacts::empty(&scratch);
        assert!(!fixture.root.join("unused-output").exists());
    }
}
