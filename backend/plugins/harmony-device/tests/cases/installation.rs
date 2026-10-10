use crate::support::{
    Fixture, INSTALL_SUCCESS, SERIAL,
    artifacts::{self, ARTIFACT_ID, DISPLAY_NAME, FILE_LIMIT},
    device, failure, success,
};
use serde_json::json;
use std::{fs, path::Path, time::Duration};

#[test]
fn installation_uses_private_input_hap_exact_bytes_and_masks_path_before_cleanup() {
    let mut fixture = Fixture::new("install-private");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let bytes = b"independent authorized HAP bytes";
    let request = artifacts::installation(&fixture, bytes);
    fixture.plan(b"unused", b"", 0);
    fs::write(fixture.root.join("echo-install-path"), b"1").unwrap();
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool();
    let argv = fixture.argv();
    assert_eq!(argv.len(), 4);
    assert_eq!(&argv[..3], ["-t", SERIAL, "install"]);
    let private = Path::new(&argv[3]);
    assert!(private.is_absolute());
    assert_eq!(private.file_name().unwrap(), "input.hap");
    assert_eq!(private.parent().unwrap().parent().unwrap(), scratch);
    assert_eq!(fs::read(private).unwrap(), bytes);
    assert_eq!(
        fs::read(fixture.root.join("call-01/install-input.bin")).unwrap(),
        bytes
    );
    fs::write(
        fixture.root.join("authorized-source.hap"),
        b"changed after copy",
    )
    .unwrap();
    assert_eq!(fs::read(private).unwrap(), bytes);
    fixture.release();
    let reply = running.complete();
    probe.assert_exited();
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,
        "output":format!("Installed {DISPLAY_NAME}\nmsg:install bundle successfully.")})
    );
    assert!(!serde_json::to_string(&reply).unwrap().contains(&argv[3]));
    assert!(!private.exists());
    artifacts::empty(&scratch);
    fixture.assert_calls(1);
}

#[test]
fn installation_uppercase_hash_and_exact_64_mib_are_accepted() {
    let mut fixture = Fixture::new("install-size-boundary");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let bytes = vec![0x5a; FILE_LIMIT];
    let mut request = artifacts::installation(&fixture, &bytes);
    let uppercase = request["artifacts"]["inputs"][0]["sha256"]
        .as_str()
        .unwrap()
        .to_ascii_uppercase();
    request["artifacts"]["inputs"][0]["sha256"] = json!(uppercase);
    assert_eq!(
        success(&fixture.run_request(request, INSTALL_SUCCESS, b"", 0)),
        &json!({"artifact_id":ARTIFACT_ID,"output":"msg:install bundle successfully."})
    );
    assert_eq!(
        fs::metadata(fixture.root.join("call-01/install-input.bin"))
            .unwrap()
            .len(),
        FILE_LIMIT as u64
    );
    artifacts::empty(&scratch);
}

#[test]
fn installation_length_and_hash_mismatch_fail_before_hdc_and_clean_scratch() {
    for (field, value, expected) in [
        ("size", json!(1), "输入无效：输入产物长度不一致"),
        (
            "sha256",
            json!("0".repeat(64)),
            "输入无效：输入产物大小或SHA256不一致",
        ),
    ] {
        let mut fixture = Fixture::new("install-integrity");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"real HAP bytes");
        request["artifacts"]["inputs"][0][field] = value;
        fixture.reject(request, expected);
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_requires_unique_pointer_id_and_hap_before_configuration() {
    for shape in 0..7 {
        let mut fixture = Fixture::new("install-authorization");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"authorized source");
        let row = request["artifacts"]["inputs"][0].clone();
        let expected = match shape {
            0 => {
                request["artifacts"] = serde_json::Value::Null;
                "输入无效：安装要求唯一输入产物副本"
            }
            1 => {
                request["artifacts"]["inputs"] = json!([row.clone(), row]);
                "输入无效：安装要求唯一输入产物副本"
            }
            2 => {
                request["artifacts"]["inputs"][0]["field"] = json!("/artifact_id");
                "输入无效：安装输入产物pointer或ID不一致"
            }
            3 => {
                request["artifacts"]["inputs"][0]["artifact_id"] = json!("other");
                "输入无效：安装输入产物pointer或ID不一致"
            }
            4 => {
                request["artifacts"]["inputs"][0]["filename"] = json!("source.apk");
                "输入无效：安装仅接受HAP产物"
            }
            5 => {
                request["artifacts"]["inputs"][0]["filename"] = json!("../source.hap");
                "输入无效：产物显示名不是有效单文件名"
            }
            _ => {
                request["artifacts"]["inputs"][0]["sha256"] = json!("bad");
                "输入无效：输入产物摘要无效"
            }
        };
        fs::write(&fixture.config_path, b"invalid-json-before-configuration").unwrap();
        fixture.reject(request, expected);
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_authorized_size_over_limit_is_rejected_before_source_read() {
    let mut fixture = Fixture::new("install-size-too-large");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let mut request = artifacts::installation(&fixture, b"small HAP");
    request["artifacts"]["inputs"][0]["size"] = json!(FILE_LIMIT + 1);
    fixture.reject(request, "数据超过插件限额");
    artifacts::empty(&scratch);
}

#[test]
fn installation_source_paths_are_absolute_regular_existing_and_no_parent_segments() {
    for shape in 0..4 {
        let mut fixture = Fixture::new("install-source-path");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"source");
        let (path, expected) = match shape {
            0 => (
                json!("source.hap"),
                "输入无效：产物和工作路径须为无父路径的绝对路径",
            ),
            1 => (
                json!(format!("{}/../escape.hap", fixture.root.display())),
                "输入无效：产物和工作路径须为无父路径的绝对路径",
            ),
            2 => (json!(fixture.root), "输入无效：资源路径类型不符合要求"),
            _ => (
                json!(fixture.root.join("missing.hap")),
                "文件操作失败：资源路径无法读取",
            ),
        };
        request["artifacts"]["inputs"][0]["path"] = path;
        fixture.reject(request, expected);
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_own_success_line_case_insensitive_suffix_and_stderr_success_are_preserved() {
    for (stdout, stderr, output) in [
        (
            b"[Info]App install path:fixture.hap msg:INSTALL BUNDLE SUCCESSFULLY.\n".as_slice(),
            b"".as_slice(),
            "[Info]App install path:fixture.hap msg:INSTALL BUNDLE SUCCESSFULLY.",
        ),
        (
            b"".as_slice(),
            INSTALL_SUCCESS,
            "msg:install bundle successfully.",
        ),
    ] {
        let fixture = Fixture::new("install-success-line");
        let request = artifacts::installation(&fixture, b"HAP bytes");
        assert_eq!(
            success(&fixture.run_request(request, stdout, stderr, 0)),
            &json!({"artifact_id":ARTIFACT_ID,"output":output})
        );
    }
}

#[test]
fn installation_missing_success_stderr_failure_invalid_utf8_and_nonzero_do_not_publish() {
    for (stdout, stderr, code, expected) in [
        (
            b"Success\n".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：HDC未返回明确成功结果",
        ),
        (
            b"msg:uninstall bundle successfully.\n".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：HDC未返回明确成功结果",
        ),
        (
            b"msg:install bundle successfully. suffix\n".as_slice(),
            b"".as_slice(),
            0,
            "工具依赖失败：HDC未返回明确成功结果",
        ),
        (
            INSTALL_SUCCESS,
            b"error: private failure".as_slice(),
            0,
            "工具依赖失败：HDC返回失败诊断",
        ),
        (
            &[0xff][..],
            b"".as_slice(),
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            INSTALL_SUCCESS,
            &[0xff][..],
            0,
            "工具依赖失败：HDC输出不是有效UTF-8",
        ),
        (
            INSTALL_SUCCESS,
            b"".as_slice(),
            3,
            "工具依赖失败：HDC客户端执行失败，请检查部署配置",
        ),
    ] {
        let mut fixture = Fixture::new("install-business-failure");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let request = artifacts::installation(&fixture, b"HAP bytes");
        failure(
            &fixture.run_request(request, stdout, stderr, code),
            expected,
        );
        artifacts::empty(&scratch);
    }
}

#[test]
fn non_install_actions_reject_input_artifacts_before_config_or_files() {
    for operation in ["discover", "packages", "app.uninstall"] {
        let fixture = Fixture::new("other-input-artifact");
        let row =
            artifacts::installation(&fixture, b"never read")["artifacts"]["inputs"][0].clone();
        let input = match operation {
            "discover" => json!({}),
            "packages" => device(json!({})),
            _ => device(json!({"package":"com.alpha.app"})),
        };
        let mut request = fixture.request(operation, input);
        request["artifacts"]["inputs"] = json!([row]);
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        fixture.reject(request, "输入无效：该设备动作不接受输入产物");
    }
}
