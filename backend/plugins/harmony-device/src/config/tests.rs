use super::*;

#[test]
fn strict_nested_configuration_and_version() {
    for bytes in [
        r#"{"format_version":1,"extra":true}"#,
        r#"{"format_version":1,"tools":{"hdc":"hdc","server":"elsewhere"}}"#,
        r#"{"tools":{"hdc":"hdc"}}"#,
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
    assert!(absent.tools.hdc.is_none());
}

#[test]
fn program_name_rejects_relative_path_arguments_and_parent_components() {
    for value in [
        "",
        " ",
        "-hdc",
        "hdc -t serial",
        "../hdc",
        "./hdc",
        "bin/hdc",
        "bin\\hdc",
        ".",
        "..",
        "C:hdc",
        "hdc\n",
    ] {
        assert!(program(value).is_err());
    }
    for value in ["hdc", "hdc.exe", "自定义HDC"] {
        assert!(program(value).is_ok());
    }
    assert!(program(&"a".repeat(4096)).is_ok());
    assert!(program(&"a".repeat(4097)).is_err());
}

#[test]
fn scratch_and_executable_paths_require_absolute_without_parents() {
    for value in ["relative", "../scratch"] {
        assert!(absolute(Path::new(value)).is_err());
    }
    #[cfg(windows)]
    let (valid, invalid) = (r"C:\工具\hdc.exe", r"C:\工具\..\hdc.exe");
    #[cfg(not(windows))]
    let (valid, invalid) = ("/tools/hdc", "/tools/../hdc");
    assert!(program(valid).is_ok());
    assert!(program(invalid).is_err());
}

#[cfg(windows)]
#[test]
fn verbatim_parent_path_is_rejected_for_both_separators() {
    for value in [r"\\?\C:\scratch\..\hdc.exe", r"\\?\C:\scratch/../hdc.exe"] {
        assert!(matches!(absolute(Path::new(value)), Err(Error::Invalid(_))));
        assert!(matches!(program(value), Err(Error::Invalid(_))));
    }
}
