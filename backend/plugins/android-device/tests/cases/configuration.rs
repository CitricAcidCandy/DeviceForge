//! 部署配置只通过进程参数进入；坏配置、缺依赖、坏工具均零启动。
use crate::support::{self, Fixture, failure};
use serde_json::json;
use std::{fs, time::Duration};

fn reject(fixture: &Fixture, expected: &str) {
    let mut running = fixture.begin("packages", support::device(json!({})));
    running.start(Duration::from_secs(20));
    failure(&running.complete(), expected);
    fixture.assert_no_tool();
}

#[test]
fn config_unknown_fields_and_duplicate_fields_are_strict() {
    for bytes in [
        r#"{"format_version":1,"unknown_scratch":null}"#,
        r#"{"format_version":1,"tools":{"adb":"adb","server":"other"}}"#,
        r#"{"format_version":1,"format_version":1}"#,
        r#"{"tools":{"adb":"adb"}}"#,
    ] {
        let fixture = Fixture::new("bad-config-json");
        fs::write(&fixture.config_path, bytes).unwrap();
        reject(&fixture, "输入无效：部署配置JSON无效");
    }
}

#[test]
fn unsupported_config_version_is_exact_error() {
    let mut fixture = Fixture::new("bad-config-version");
    fixture.config["format_version"] = json!(2);
    fixture.save_config();
    reject(&fixture, "输入无效：配置版本必须为1");
}

#[test]
fn absent_or_null_adb_is_dependency_failure_not_empty_success() {
    for config in [
        json!({"format_version":1}),
        json!({"format_version":1,"tools":{"adb":null}}),
    ] {
        let mut fixture = Fixture::new("missing-adb");
        fixture.config = config;
        fixture.save_config();
        reject(&fixture, "工具依赖失败：部署者未配置ADB入口");
    }
}

#[test]
fn relative_adb_path_or_free_arguments_are_not_program_names() {
    for entry in ["./adb", "bin/adb", "../adb", "adb -s other", "-adb"] {
        let mut fixture = Fixture::new("invalid-program");
        fixture.config["tools"]["adb"] = json!(entry);
        fixture.save_config();
        reject(&fixture, "输入无效：ADB入口须为绝对路径或单一程序名");
    }
}

#[test]
fn adb_directory_and_missing_file_have_distinct_exact_failures() {
    let mut fixture = Fixture::new("adb-directory");
    fixture.config["tools"]["adb"] = json!(fixture.root);
    fixture.save_config();
    reject(&fixture, "输入无效：配置或工具入口不是普通文件");
    let mut fixture = Fixture::new("adb-missing-file");
    fixture.config["tools"]["adb"] = json!(fixture.root.join("missing-adb"));
    fixture.save_config();
    reject(&fixture, "文件操作失败：配置或工具路径无法读取");
}

#[test]
fn explicit_config_missing_and_oversize_are_not_implicit_defaults() {
    let fixture = Fixture::new("config-missing");
    fs::remove_file(&fixture.config_path).unwrap();
    reject(&fixture, "文件操作失败：部署配置无法读取");
    let fixture = Fixture::new("config-too-large");
    fs::write(&fixture.config_path, vec![b' '; 65537]).unwrap();
    reject(&fixture, "数据超过插件限额");
}

#[test]
fn regular_non_executable_adb_has_fixed_spawn_failure_without_path_leak() {
    let mut fixture = Fixture::new("bad-adb-file");
    let path = fixture.root.join("not-executable.bin");
    fs::write(&path, b"not an executable").unwrap();
    fixture.config["tools"]["adb"] = json!(path);
    fixture.save_config();
    reject(
        &fixture,
        "工具依赖失败：无法启动设备连接工具，请检查工具是否已安装且路径正确",
    );
}
