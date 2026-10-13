use super::*;

#[test]
fn ability_is_optional_but_explicit_values_must_be_valid_strings() {
    assert!(matches!(
        parse("app.start", "serial".into(), &json!({"bundle":"demo.app"})).unwrap(),
        Input::Start { ability: None, .. }
    ));
    for ability in ["EntryAbility", "demo.Entry_Ability", &"A".repeat(200)] {
        assert!(matches!(
            parse(
                "app.start",
                "serial".into(),
                &json!({"bundle":"demo.app","ability":ability})
            )
            .unwrap(),
            Input::Start {
                ability: Some(_),
                ..
            }
        ));
    }
    for ability in [
        json!(null),
        json!(false),
        json!(""),
        json!(" "),
        json!("-flag"),
        json!("A;id"),
        json!("A\n"),
        json!("1Ability"),
        json!("A..B"),
        json!("A".repeat(201)),
    ] {
        assert!(
            parse(
                "app.start",
                "serial".into(),
                &json!({"bundle":"demo.app","ability":ability})
            )
            .is_err()
        );
    }
}

#[test]
fn all_actions_reject_extra_missing_wrong_fields_and_invalid_bundle() {
    for operation in ["app.detail", "app.start", "app.stop", "app.reset"] {
        for input in [
            json!({}),
            json!({"package":"demo.app"}),
            json!({"bundle":"demo.app","module":"entry"}),
            json!({"bundle":null}),
            json!({"bundle":"demo;id"}),
            json!({"bundle":"demo..app"}),
            json!([]),
        ] {
            assert!(parse(operation, "serial".into(), &input).is_err());
        }
    }
    for operation in ["app.detail", "app.stop", "app.reset"] {
        assert!(
            parse(
                operation,
                "serial".into(),
                &json!({"bundle":"demo.app","ability":"EntryAbility"})
            )
            .is_err()
        );
    }
}

#[test]
fn complete_success_line_is_required_and_failure_always_wins() {
    let expected = "start ability successfully";
    for text in [
        "start ability successfully",
        " START ABILITY SUCCESSFULLY \r\n",
    ] {
        assert!(rules::success_line(text.as_bytes(), b"", expected).is_ok());
    }
    assert!(rules::success_line(b"", b"start ability successfully\n", expected).is_ok());
    for text in [
        "prefix start ability successfully",
        "start ability successfully suffix",
        "start ability successfully.",
        "force stop process successfully.",
        "",
    ] {
        assert!(rules::success_line(text.as_bytes(), b"", expected).is_err());
    }
    assert!(
        rules::success_line(b"start ability successfully\nerror: private", b"", expected).is_err()
    );
    assert!(
        rules::success_line(b"start ability successfully", b"failed: private", expected).is_err()
    );
}

#[test]
fn exact_hdc_fail_tag_wins_over_each_application_success_in_either_stream() {
    for expected in [
        "start ability successfully",
        "force stop process successfully.",
        "clean bundle data files successfully.",
    ] {
        for (stdout, stderr) in [
            (
                format!("{expected}\n[Fail] independent diagnostic"),
                String::new(),
            ),
            (
                expected.to_owned(),
                "[FAIL] independent diagnostic".to_owned(),
            ),
        ] {
            assert_eq!(
                rules::success_line(stdout.as_bytes(), stderr.as_bytes(), expected)
                    .unwrap_err()
                    .to_string(),
                "工具依赖失败：HDC返回失败诊断"
            );
        }
    }
}

#[test]
fn exact_hdc_fail_tag_in_detail_stderr_prevents_automatic_ability_selection() {
    assert_eq!(
        details::parse(
            br#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
            b"[Fail] independent detail diagnostic",
            "demo.app",
        )
        .unwrap_err()
        .to_string(),
        "工具依赖失败：HDC返回失败诊断"
    );
}

#[test]
fn detail_uses_legacy_first_module_with_title_or_plain_json() {
    let body = r#"{"name":"demo.failed","hapModuleInfos":[{"bundleName":"demo.failed","mainAbility":"EntryAbility"},{"mainAbility":"Other"}]}"#;
    for prefix in ["", "demo.failed:\n", "demo.failed:\r\n"] {
        assert_eq!(
            automatic_ability(format!("{prefix}{body}").as_bytes(), b"", "demo.failed").unwrap(),
            "EntryAbility"
        );
    }
}

#[test]
fn public_detail_preserves_unknown_fields_and_non_startable_module_shapes() {
    let expected = json!({
        "name":"demo.app",
        "versionCode":7,
        "custom":{"enabled":true,"text":"failed is ordinary data"},
        "metadata":[1,"two"],
        "hapModuleInfos":[{"bundleName":"other.app","mainElementName":"Entry"},null]
    });
    for prefix in ["", "demo.app:\n", "demo.app:\r\n"] {
        let body = format!("{prefix}{expected}");
        let value = details::parse(body.as_bytes(), b"", "demo.app").unwrap();
        assert_eq!(value, expected);
        assert_eq!(
            details::ability(&value, "demo.app")
                .unwrap_err()
                .to_string(),
            "工具依赖失败：应用详情首模块包名与请求不一致"
        );
    }
    let without_modules = json!({"status":"installed","custom":[true,7]});
    assert_eq!(
        details::parse(without_modules.to_string().as_bytes(), b"", "demo.app").unwrap(),
        without_modules
    );
}

#[test]
fn public_detail_root_name_must_match_without_requiring_startable_shape() {
    assert!(details::parse(br#"{"name":"demo.app"}"#, b"", "demo.app").is_ok());
    for body in [
        br#"{"name":"other.app"}"#.as_slice(),
        br#"{"name":null}"#.as_slice(),
        br#"{"name":7}"#.as_slice(),
    ] {
        assert_eq!(
            details::parse(body, b"", "demo.app")
                .unwrap_err()
                .to_string(),
            "工具依赖失败：应用详情包名与请求不一致"
        );
    }
}

#[test]
fn detail_rejects_unknown_prefix_duplicates_tail_and_missing_shape() {
    for body in [
        r#"other.app:
{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
        r#"{"name":"other.app","hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
        r#"{"hapModuleInfos":[{"bundleName":"other.app","mainAbility":"EntryAbility"}]}"#,
        r#"{"hapModuleInfos":[{"mainAbility":"bad ability"}]}"#,
        r#"{"hapModuleInfos":[{"mainElementName":"EntryAbility"}]}"#,
        r#"{"hapModuleInfos":[]}"#,
        r#"{"hapModuleInfos":[null]}"#,
        r#"{"hapModuleInfos":[{"mainAbility":"EntryAbility","mainAbility":"Other"}]}"#,
        r#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]} trailing"#,
        r#"[]"#,
    ] {
        assert!(automatic_ability(body.as_bytes(), b"", "demo.app").is_err());
    }
    assert!(
        automatic_ability(
            br#"{"hapModuleInfos":[{"mainAbility":"EntryAbility"}]}"#,
            b"error: denied",
            "demo.app"
        )
        .is_err()
    );
}

#[test]
fn detail_has_module_depth_and_node_limits() {
    let modules = json!({"hapModuleInfos":vec![json!({"mainAbility":"EntryAbility"});128]});
    assert_eq!(
        automatic_ability(modules.to_string().as_bytes(), b"", "demo.app").unwrap(),
        "EntryAbility"
    );
    let modules = json!({"hapModuleInfos":vec![json!({"mainAbility":"EntryAbility"});129]});
    assert!(automatic_ability(modules.to_string().as_bytes(), b"", "demo.app").is_err());
    let deep = format!("{}null{}", "[".repeat(65), "]".repeat(65));
    assert!(automatic_ability(deep.as_bytes(), b"", "demo.app").is_err());
    let nodes = format!("[{}0]", "0,".repeat(100_001));
    assert!(automatic_ability(nodes.as_bytes(), b"", "demo.app").is_err());
}

fn automatic_ability(stdout: &[u8], stderr: &[u8], bundle: &str) -> Result<String> {
    details::ability(&details::parse(stdout, stderr, bundle)?, bundle)
}
