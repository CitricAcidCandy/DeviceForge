//! 配置资格不触发工具；逐层结构和路径规则拒绝绕过。
use super::*;

#[cfg(windows)]
#[test]
fn verbatim_configuration_paths_reject_both_parent_separators() {
    for value in [r"\\?\C:\scratch\..\adb.exe", r"\\?\C:\scratch/../adb.exe"] {
        assert!(matches!(absolute(Path::new(value)), Err(Error::Invalid(_))));
        assert!(matches!(program(value), Err(Error::Invalid(_))));
    }
}

#[test]
fn strict_configuration_version_and_nested_fields() {
    for bytes in [
        r#"{"format_version":1,"scratch_root":null,"extra":true}"#,
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

#[test]
fn scratch_root_is_optional_absolute_and_rejects_parent_or_relative_paths() {
    let omitted: Config = serde_json::from_str(r#"{"format_version":1}"#).unwrap();
    assert!(omitted.scratch_root.is_none());
    let null: Config = serde_json::from_str(r#"{"format_version":1,"scratch_root":null}"#).unwrap();
    assert!(null.validate().is_ok());
    for path in ["relative", "../scratch"] {
        let config: Config =
            serde_json::from_value(serde_json::json!({"format_version":1,"scratch_root":path}))
                .unwrap();
        assert!(config.validate().is_err());
    }
    #[cfg(windows)]
    let (valid, invalid) = (r"C:\工作", r"C:\工作\..\别处");
    #[cfg(not(windows))]
    let (valid, invalid) = ("/workspace/scratch", "/workspace/../elsewhere");
    for (path, accepted) in [(valid, true), (invalid, false)] {
        let config: Config =
            serde_json::from_value(serde_json::json!({"format_version":1,"scratch_root":path}))
                .unwrap();
        assert_eq!(config.validate().is_ok(), accepted);
    }
}

#[test]
fn apks_java_and_jar_configuration_is_optional_but_has_a_fixed_shape() {
    #[cfg(windows)]
    let jar = r"C:\工具目录\bundletool.jar";
    #[cfg(not(windows))]
    let jar = "/tools/bundletool.jar";
    let valid: Config = serde_json::from_value(serde_json::json!({
        "format_version":1,"tools":{"adb":"adb","java":"java","bundletool":{"kind":"java_jar","jar":jar}}
    })).unwrap();
    assert!(valid.validate().is_ok());
    for tool in [
        serde_json::json!({"kind":"executable","executable":"bundletool"}),
        serde_json::json!({"kind":"java_jar","jar":jar,"args":["--anything"]}),
        serde_json::json!({"kind":"java_jar"}),
    ] {
        assert!(
            serde_json::from_value::<Config>(
                serde_json::json!({"format_version":1,"tools":{"bundletool":tool}})
            )
            .is_err()
        );
    }
    for tool in [
        serde_json::json!({"java":"java -jar request.jar"}),
        serde_json::json!({"bundletool":{"kind":"java_jar","jar":"relative.jar"}}),
    ] {
        let invalid: Config =
            serde_json::from_value(serde_json::json!({"format_version":1,"tools":tool})).unwrap();
        assert!(invalid.validate().is_err());
    }
}

#[test]
fn unicode_input_requires_the_fixed_adb_keyboard_target() {
    let valid: Config = serde_json::from_value(serde_json::json!({
        "format_version": 1,
        "unicode_input": {
            "package": "com.android.adbkeyboard",
            "component": "com.android.adbkeyboard/.AdbIME",
            "action": "ADB_INPUT_TEXT",
            "extra": "msg"
        }
    }))
    .unwrap();
    assert!(valid.validate().is_ok());
    for field in ["package", "component", "action", "extra"] {
        let mut value = serde_json::json!({
            "format_version": 1,
            "unicode_input": {
                "package": "com.android.adbkeyboard",
                "component": "com.android.adbkeyboard/.AdbIME",
                "action": "ADB_INPUT_TEXT",
                "extra": "msg"
            }
        });
        value["unicode_input"][field] = serde_json::Value::String("other".into());
        let invalid: Config = serde_json::from_value(value).unwrap();
        assert!(
            invalid.validate().is_err(),
            "未拒绝Unicode目标字段：{field}"
        );
    }
    let unknown = serde_json::from_str::<Config>(
        r#"{"format_version":1,"unicode_input":{"package":"com.android.adbkeyboard","component":"com.android.adbkeyboard/.AdbIME","action":"ADB_INPUT_TEXT","extra":"msg","args":[]}}"#,
    );
    assert!(unknown.is_err());
}
