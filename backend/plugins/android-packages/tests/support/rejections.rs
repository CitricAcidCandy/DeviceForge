//! 独立坏配置、产物关联及业务样本；每个错误必须精确，不接受任意失败。
use crate::support::{
    self, Fixture,
    wire::{Invocation, failure, success},
    zip,
};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

fn rejected(fixture: &Fixture, request: Value, expected: &str) {
    let mut invocation = fixture.begin_request(request);
    invocation.start(Duration::from_secs(20));
    failure(&invocation.complete(), expected);
    fixture.assert_no_tool();
    fixture.assert_no_output();
    fixture.assert_released();
}
fn manifest_rejected(fixture: &Fixture, expected: &str) {
    rejected(fixture, fixture.request("manifest", json!({})), expected);
}

#[test]
fn configuration_rejects_wrong_version_and_unknown_root_or_nested_fields() {
    for (name, expected) in [
        ("version", "输入无效：配置版本必须为1"),
        ("root", "输入无效：部署配置JSON无效"),
        ("nested", "输入无效：部署配置JSON无效"),
    ] {
        let mut fixture = Fixture::new("输入.apk", support::apk());
        match name {
            "version" => fixture.config["format_version"] = json!(2),
            "root" => fixture.config["unexpected"] = json!(true),
            "nested" => fixture.config["tools"]["apkanalyzer"]["unexpected"] = json!(true),
            _ => unreachable!(),
        }
        fixture.save_config();
        manifest_rejected(&fixture, expected);
    }
}

#[test]
fn configuration_rejects_invalid_json_and_over_64_kib_without_tool() {
    for bytes in [b"{broken".to_vec(), vec![b' '; 65_537]] {
        let fixture = Fixture::new("输入.apk", support::apk());
        fs::write(&fixture.config_path, &bytes).unwrap();
        manifest_rejected(
            &fixture,
            if bytes.len() > 65_536 {
                "数据超过插件限额"
            } else {
                "输入无效：部署配置JSON无效"
            },
        );
    }
}

#[test]
fn configuration_rejects_relative_path_and_missing_explicit_file() {
    for (path, expected) in [
        (
            Path::new("配置.json"),
            "输入无效：配置路径须为不含越界的绝对路径",
        ),
        (Path::new("missing"), "文件操作失败：部署配置无法读取"),
    ] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let argument = if path == Path::new("missing") {
            fixture.root.join(path)
        } else {
            path.to_path_buf()
        };
        let mut invocation = Invocation::spawn_config_arg(
            &argument,
            &fixture.root,
            fixture.request("manifest", json!({})),
        );
        invocation.start(Duration::from_secs(20));
        failure(&invocation.complete(), expected);
        fixture.assert_no_tool();
        fixture.assert_no_output();
        fixture.assert_released();
    }
}

#[test]
fn configuration_rejects_wrong_tool_kind_and_missing_dependency() {
    let mut wrong = Fixture::new("输入.aab", support::aab());
    wrong.config["tools"]["bundletool"] = wrong.config["tools"]["apkanalyzer"].clone();
    wrong.save_config();
    manifest_rejected(&wrong, "输入无效：工具入口类型不符合配置契约");
    let mut missing = Fixture::new("输入.apk", support::apk());
    missing.config["tools"]
        .as_object_mut()
        .unwrap()
        .remove("apkanalyzer");
    missing.save_config();
    manifest_rejected(&missing, "工具依赖失败：部署者未配置所需工具");
}

#[test]
fn artifacts_context_is_required_and_inputs_must_be_exactly_one() {
    for count in [None, Some(0), Some(2)] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        if let Some(count) = count {
            request["artifacts"]["inputs"] = json!(vec![fixture.metadata(); count]);
        } else {
            request.as_object_mut().unwrap().remove("artifacts");
        }
        rejected(
            &fixture,
            request,
            if count.is_none() {
                "输入无效：缺少宿主产物上下文"
            } else {
                "输入无效：要求唯一输入产物副本"
            },
        );
    }
}

#[test]
fn artifact_field_and_business_id_must_match_the_unique_copy() {
    for field in ["field", "artifact_id"] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        request["artifacts"]["inputs"][0][field] = json!(if field == "field" {
            "another"
        } else {
            "00000000-0000-0000-0000-000000000000"
        });
        rejected(&fixture, request, "输入无效：输入产物关联不一致");
    }
}

#[test]
fn artifact_rejects_oversized_metadata_and_malformed_sha() {
    for (field, value, expected) in [
        ("size", json!(64_u64 * 1024 * 1024 + 1), "数据超过插件限额"),
        ("sha256", json!("abcd"), "输入无效：输入产物摘要无效"),
        (
            "sha256",
            json!("g".repeat(64)),
            "输入无效：输入产物摘要无效",
        ),
    ] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        request["artifacts"]["inputs"][0][field] = value;
        rejected(&fixture, request, expected);
    }
}

#[test]
fn artifact_actual_size_and_private_copy_sha_are_checked_before_tool() {
    for (field, value, expected) in [
        ("size", json!(1), "输入无效：输入产物长度不一致"),
        (
            "sha256",
            json!("00".repeat(32)),
            "输入无效：输入产物摘要不一致",
        ),
    ] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        request["artifacts"]["inputs"][0][field] = value;
        rejected(&fixture, request, expected);
    }
}

#[test]
fn artifact_directory_and_missing_output_authorization_are_rejected() {
    for output_missing in [false, true] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        if output_missing {
            request["artifacts"]
                .as_object_mut()
                .unwrap()
                .remove("output_directory");
        } else {
            request["artifacts"]["inputs"][0]["path"] = json!(fixture.scratch);
        }
        rejected(
            &fixture,
            request,
            if output_missing {
                "输入无效：未获产物输出授权"
            } else {
                "输入无效：路径类型不符合声明"
            },
        );
    }
}

#[test]
fn artifact_filename_traversal_and_wrong_operation_format_are_rejected() {
    for (name, expected) in [
        ("../输入.apk", "输入无效：文件名为空、超限或包含路径"),
        ("输入.zip", "输入无效：产物格式不符合操作要求"),
    ] {
        let fixture = Fixture::new("输入.apk", support::apk());
        let mut request = fixture.request("manifest", json!({}));
        request["artifacts"]["inputs"][0]["filename"] = json!(name);
        rejected(&fixture, request, expected);
    }
}

#[test]
fn full_contribution_id_is_not_a_valid_process_operation() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut request = fixture.request("manifest", json!({}));
    request["operation"] = json!("plugin.android-packages.manifest");
    rejected(&fixture, request, "输入无效：未知安卓包操作");
}

#[test]
fn all_seven_inputs_reject_unknown_business_fields_before_configuration() {
    for (operation, name, bytes, mut input) in [
        ("manifest", "输入.apk", support::apk(), json!({})),
        ("signature", "输入.apk", support::apk(), json!({})),
        (
            "extract_apk",
            "输入.apks",
            support::apks(),
            json!({"entry":"universal.apk"}),
        ),
        (
            "build_apks",
            "输入.aab",
            support::aab(),
            json!({"mode":"universal"}),
        ),
        ("decode", "输入.apk", support::apk(), json!({})),
        (
            "scan_sdks",
            "输入.zip",
            support::decoded(),
            json!({"rules":[{"name":"样本","package_path":"com.example.sdk"}]}),
        ),
        (
            "extract_splits",
            "输入.apks",
            support::apks(),
            json!({"device_spec":support::device_spec()}),
        ),
    ] {
        let fixture = Fixture::new(name, bytes);
        input["unexpected"] = json!(true);
        fs::write(&fixture.config_path, b"bad-json-must-not-be-read").unwrap();
        rejected(
            &fixture,
            fixture.request(operation, input),
            "输入无效：业务输入字段或类型无效",
        );
    }
}

#[test]
fn invalid_uuid_and_apk_module_are_exact_business_errors() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let mut request = fixture.request("manifest", json!({}));
    request["input"]["artifact_id"] = json!("not-a-uuid");
    rejected(&fixture, request, "输入无效：产物 ID 必须为规范 UUID");
    let fixture = Fixture::new("输入.apk", support::apk());
    rejected(
        &fixture,
        fixture.request("manifest", json!({"module":"base"})),
        "输入无效：APK 不接受 AAB 模块参数",
    );
}

#[test]
fn unsafe_exact_entry_and_invalid_sdk_or_device_spec_are_rejected() {
    let fixture = Fixture::new("输入.apks", support::apks());
    rejected(
        &fixture,
        fixture.request("extract_apk", json!({"entry":"../outside.apk"})),
        "输入无效：APK 条目名称必须为安全的精确相对路径",
    );
    let fixture = Fixture::new("输入.zip", support::decoded());
    rejected(&fixture, fixture.request("scan_sdks", json!({"rules":[
        {"name":"重复","package_path":"com.example"},{"name":"重复","package_path":"com.example"}]})),
        "输入无效：SDK 规则名称、包路径或类名无效");
    let fixture = Fixture::new("输入.apks", support::apks());
    let mut spec = support::device_spec();
    spec["screen_density"] = json!(0);
    rejected(
        &fixture,
        fixture.request("extract_splits", json!({"device_spec":spec})),
        "输入无效：设备规格列表或数值无效",
    );
}

#[test]
fn apks_exact_entry_missing_and_duplicate_have_distinct_errors() {
    let body = support::apk();
    for (bytes, expected) in [
        (
            zip::stored(&[("another.apk", &body)]),
            "输入无效：归档不存在指定成员",
        ),
        (
            zip::stored(&[("universal.apk", &body), ("universal.apk", &body)]),
            "输入无效：ZIP 包含重复条目",
        ),
    ] {
        let fixture = Fixture::new("输入.apks", bytes);
        rejected(
            &fixture,
            fixture.request("extract_apk", json!({"entry":"universal.apk"})),
            expected,
        );
    }
}

#[test]
fn apks_selected_crc_mismatch_rejects_before_output_and_summary() {
    let mut bytes = support::apks();
    // 修改第一个 Stored 成员数据，保留 local/central 的原 CRC；产物 SHA 则如实重算。
    bytes[30 + "universal.apk".len()] ^= 0x40;
    let fixture = Fixture::new("输入.apks", bytes);
    rejected(
        &fixture,
        fixture.request("extract_apk", json!({"entry":"universal.apk"})),
        "输入无效：包结构或工具输出不符合约束",
    );
}

#[test]
fn missing_java_and_signing_are_not_silent_tool_fallbacks() {
    let mut fixture = Fixture::new("输入.aab", support::aab());
    fixture.config["tools"]
        .as_object_mut()
        .unwrap()
        .remove("java");
    fixture.save_config();
    manifest_rejected(&fixture, "工具依赖失败：部署者未配置Java入口");
    let mut fixture = Fixture::new("输入.aab", support::aab());
    fixture.config.as_object_mut().unwrap().remove("signing");
    fixture.save_config();
    rejected(
        &fixture,
        fixture.request("build_apks", json!({"mode":"universal"})),
        "工具依赖失败：部署者未配置构建签名文件",
    );
}

#[test]
fn nonzero_tools_preserve_operation_mapping_without_stderr_or_output() {
    for (operation, name, bytes, input, expected) in [
        (
            "manifest",
            "输入.apk",
            support::apk(),
            json!({}),
            "工具依赖失败：工具执行失败，请检查部署配置",
        ),
        (
            "build_apks",
            "输入.aab",
            support::aab(),
            json!({"mode":"universal"}),
            "工具依赖失败：AAB 构建工具失败，请检查工具和签名配置",
        ),
        (
            "decode",
            "输入.apk",
            support::apk(),
            json!({}),
            "工具依赖失败：工具执行失败，请检查部署配置",
        ),
    ] {
        let fixture = Fixture::new(name, bytes);
        fs::write(fixture.tools.join("mode.txt"), "nonzero").unwrap();
        let reply = fixture.normal(operation, input, true);
        failure(&reply, expected);
        fixture.assert_no_output();
        assert!(!serde_json::to_string(&reply).unwrap().contains("诊断哨兵"));
    }
}

#[test]
fn non_utf8_tool_stdout_is_exact_dependency_error() {
    let fixture = Fixture::new("输入.apk", support::apk());
    fs::write(fixture.tools.join("manifest.xml"), [0xff]).unwrap();
    failure(
        &fixture.normal("manifest", json!({}), true),
        "工具依赖失败：工具标准输出不是UTF-8",
    );
    fixture.assert_no_output();
}

#[test]
fn manifest_tool_rejects_undefined_namespace_entity() {
    let fixture = Fixture::new("输入.apk", support::apk());
    fs::write(
        fixture.tools.join("manifest.xml"),
        r#"<manifest xmlns:a="&undeclared;" package="org.fixture.app"/>"#,
    )
    .unwrap();
    failure(
        &fixture.normal("manifest", json!({}), true),
        "输入无效：包结构或工具输出不符合约束",
    );
    fixture.assert_no_output();
}

#[test]
fn manifest_tool_decodes_equivalent_namespace_uri_into_original_dto() {
    let fixture = Fixture::new("输入.apk", support::apk());
    let xml = r#"<manifest xmlns:a="http://schemas.android.com/apk/res/andro&#105;d" package="org.fixture.app" a:versionName="等价"/>"#;
    fs::write(fixture.tools.join("manifest.xml"), xml).unwrap();
    let reply = fixture.normal("manifest", json!({}), true);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":support::ARTIFACT_ID,
        "format":"apk","module":null,"package_name":"org.fixture.app","version_code":null,
        "version_name":"等价","min_sdk":null,"target_sdk":null,"application_label":null,
        "debuggable":null,"permissions":[],"xml":xml})
    );
    fixture.assert_no_output();
}

#[test]
fn manifest_tool_rejects_duplicate_expanded_namespace_attribute() {
    let fixture = Fixture::new("输入.apk", support::apk());
    fs::write(
        fixture.tools.join("manifest.xml"),
        r#"<manifest
        xmlns:a="http://schemas.android.com/apk/res/andro&#105;d"
        xmlns:b="http://schemas.android.com/apk/res/android" package="org.fixture.app"
        a:versionName="first" b:versionName="second"/>"#,
    )
    .unwrap();
    failure(
        &fixture.normal("manifest", json!({}), true),
        "输入无效：包结构或工具输出不符合约束",
    );
    fixture.assert_no_output();
}
