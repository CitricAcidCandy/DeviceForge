use crate::support::{Fixture, device, failure};
use serde_json::json;
use std::{fs, time::Duration};

fn reject(fixture: &Fixture, expected: &str) {
    let mut running = fixture.begin("packages", device(json!({})));
    running.start(Duration::from_secs(20));
    failure(&running.complete(), expected);
    fixture.assert_calls(0);
}

#[test]
fn configuration_unknown_duplicate_and_missing_fields_are_strict() {
    for bytes in [
        r#"{"format_version":1,"unknown":true}"#,
        r#"{"format_version":1,"tools":{"hdc":"hdc","adb":"adb"}}"#,
        r#"{"format_version":1,"format_version":1}"#,
        r#"{"tools":{"hdc":"hdc"}}"#,
    ] {
        let fixture = Fixture::new("bad-config");
        fs::write(&fixture.config_path, bytes).unwrap();
        reject(&fixture, "输入无效：部署配置JSON无效");
    }
}

#[test]
fn configuration_version_and_explicit_missing_file_have_fixed_errors() {
    let mut fixture = Fixture::new("bad-config-version");
    fixture.config["format_version"] = json!(2);
    fixture.save_config();
    reject(&fixture, "输入无效：配置版本必须为1");

    let fixture = Fixture::new("missing-config");
    fs::remove_file(&fixture.config_path).unwrap();
    reject(&fixture, "文件操作失败：部署配置无法读取");
}

#[test]
fn absent_or_null_hdc_is_dependency_failure_and_not_empty_success() {
    for config in [
        json!({"format_version":1}),
        json!({"format_version":1,"tools":{"hdc":null}}),
    ] {
        let mut fixture = Fixture::new("missing-hdc");
        fixture.config = config;
        fixture.save_config();
        reject(&fixture, "工具依赖失败：部署者未配置HDC入口");
    }
}

#[test]
fn relative_freeform_and_parent_hdc_values_are_rejected_before_tool_start() {
    for value in ["./hdc", "bin/hdc", "../hdc", "hdc -t other", "-hdc"] {
        let mut fixture = Fixture::new("invalid-hdc-program");
        fixture.config["tools"]["hdc"] = json!(value);
        fixture.save_config();
        reject(&fixture, "输入无效：HDC入口须为绝对路径或单一程序名");
    }
}

#[test]
fn config_size_limit_is_checked_before_hdc() {
    let fixture = Fixture::new("large-config");
    fs::write(&fixture.config_path, vec![b' '; 65_537]).unwrap();
    reject(&fixture, "数据超过插件限额");
}
