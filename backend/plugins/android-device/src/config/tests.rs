//! 配置资格不触发工具；逐层结构和路径规则拒绝绕过。
use super::*;

#[test]
fn strict_configuration_version_and_nested_fields() {
    for bytes in [
        r#"{"format_version":1,"scratch_root":null}"#,
        r#"{"format_version":1,"tools":{"adb":"adb","server":"elsewhere"}}"#,
        r#"{"tools":{"adb":"adb"}}"#,
        r#"{"format_version":1,"format_version":1}"#,
    ] {
        assert!(serde_json::from_str::<Config>(bytes).is_err());
    }
    assert!(
        serde_json::from_str::<Config>(r#"{"format_version":2}"#)
            .unwrap()
            .validate()
            .is_err()
    );
    let absent: Config = serde_json::from_str(r#"{"format_version":1}"#).unwrap();
    assert!(absent.validate().is_ok());
    assert!(absent.tools.adb.is_none());
}

#[test]
fn single_program_name_rejects_relative_paths_and_free_arguments() {
    for value in [
        "",
        " ",
        "-adb",
        "adb -s serial",
        "../adb",
        "./adb",
        "bin/adb",
        "bin\\adb",
        ".",
        "..",
        "C:adb",
        "adb\n",
    ] {
        assert!(program(value).is_err(), "无效入口未拒绝");
    }
    for value in ["adb", "adb.exe", "自定义ADB"] {
        assert!(program(value).is_ok());
    }
    assert!(program(&"a".repeat(4096)).is_ok());
    assert!(program(&"a".repeat(4097)).is_err());
}

#[test]
fn absolute_executable_path_cannot_traverse_parent() {
    #[cfg(windows)]
    let (valid, invalid) = (r"C:\工具目录\adb.exe", r"C:\工具目录\..\adb.exe");
    #[cfg(not(windows))]
    let (valid, invalid) = ("/tools/adb", "/tools/../adb");
    assert!(program(valid).is_ok());
    assert!(program(invalid).is_err());
}
