use super::*;

const HELP: &str = "usage: uitest <command> [options]\nclick/doubleClick/longClick <x> <y>   click on the target coordinates\nswipe/drag <from_x> <from_y> <to_x> <to_y> [velocity]  velocity ranges from 200 to 40000, default 600\nkeyEvent <keyID/Back/Home/Power> inject keyEvent\ninputText <x> <y> <text> inputText at the target coordinate point\n";

#[test]
fn successful_platform_message_is_exact_no_error_and_not_generic_error_scan() {
    assert!(receipt::success("No Error\n\n").is_ok());
    for output in [
        "",
        "success",
        "No error",
        "No Error\nfailed",
        "error: denied",
        "Initialization failed.",
    ] {
        assert!(receipt::success(output).is_err());
    }
}

#[test]
fn profile_requires_exact_tool_version_and_each_official_help_grammar_once() {
    assert!(receipt::version("5.0.1.1\r\n").is_ok());
    assert!(receipt::help(HELP).is_ok());
    for version in ["", "5.0", "5.0.1.2", "version 5.0.1.1", "5.0.1.1\nfailed"] {
        assert!(receipt::version(version).is_err());
    }
    for help in [
        HELP.replace("[velocity]", "[duration]"),
        HELP.replace("200 to 40000", "100 to 40000"),
        HELP.replace("inputText <x> <y> <text>", "inputText <text>"),
        format!("{HELP}keyEvent <keyID/Back/Home/Power> inject keyEvent\n"),
        format!("{HELP}[Fail] permission denied\n"),
    ] {
        assert!(receipt::help(&help).is_err());
    }
}

#[test]
fn completed_nonzero_frame_proves_termination_without_proving_action_success() {
    let frame = format!("Initialization failed.\n\nDF_INPUT_DONE:{TOKEN}:action:1\n");
    let parsed = receipt::parse(frame.as_bytes(), TOKEN, "action").unwrap();
    assert_eq!(parsed.status, 1);
    assert!(receipt::success(&parsed.body).is_err());
    let normal = format!("No Error\n\nDF_INPUT_DONE:{TOKEN}:action:0\n");
    let parsed = receipt::parse(normal.as_bytes(), TOKEN, "action").unwrap();
    assert_eq!(parsed.status, 0);
    assert!(receipt::success(&parsed.body).is_ok());
    assert!(receipt::parse(normal.replace('\n', "\r\n").as_bytes(), TOKEN, "action").is_ok());
}

#[test]
fn terminal_receipt_rejects_forged_repeated_partial_or_late_frames() {
    for frame in [
        format!("DF_INPUT_DONE:{TOKEN}:action:0"),
        format!("DF_INPUT_DONE:{TOKEN}:action:0\nlater\n"),
        format!("DF_INPUT_DONE:{TOKEN}:action:0\nDF_INPUT_DONE:{TOKEN}:action:0\n"),
        format!("DF_INPUT_DONE:{TOKEN}:enter:0\n"),
        "DF_INPUT_DONE:other:action:0\n".into(),
        format!("DF_INPUT_DONE:{TOKEN}:action:0\n\n"),
        format!("DF_INPUT_DONE:{TOKEN}:action:0\r"),
    ] {
        assert!(receipt::parse(frame.as_bytes(), TOKEN, "action").is_err());
    }
    for status in ["", "00", "+0", "-1", "256", " 0", "0:extra"] {
        let frame = format!("DF_INPUT_DONE:{TOKEN}:action:{status}\n");
        assert!(receipt::parse(frame.as_bytes(), TOKEN, "action").is_err());
    }
    let frame = format!("DF_INPUT_DONE:{TOKEN}:action:255\n");
    assert_eq!(
        receipt::parse(frame.as_bytes(), TOKEN, "action")
            .unwrap()
            .status,
        255
    );
    assert!(receipt::parse(&[0xff, b'\n'], TOKEN, "action").is_err());
}
