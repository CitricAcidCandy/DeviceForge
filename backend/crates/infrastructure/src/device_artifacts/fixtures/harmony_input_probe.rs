//! 旧运行验收的假HDC只确认版本探测结束，不声明实际uitest输入支持。
fn receipt(arguments: &[String]) -> Option<String> {
    if arguments.len() != 4 || arguments[0] != "-t" || arguments[2] != "shell" {
        return None;
    }
    let token = arguments[3]
        .strip_prefix("uitest --version 2>&1\ninput_status=$?\nprintf '\\nDF_INPUT_DONE:")?
        .strip_suffix(":version:%s\\n' \"$input_status\"\n")?;
    if token.len() != 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    // 127表示远端工具不存在；关联终端帧只证明本笔探测已经结束。
    Some(format!(
        "uitest not found\n\nDF_INPUT_DONE:{token}:version:127\n"
    ))
}

pub fn run(arguments: &[String]) -> bool {
    let Some(receipt) = receipt(arguments) else {
        return false;
    };
    print!("{receipt}");
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(token: &str, stage: &str) -> Vec<String> {
        vec![
            "-t".into(),
            "fixture-only".into(),
            "shell".into(),
            format!(
                "uitest --version 2>&1\ninput_status=$?\nprintf '\\nDF_INPUT_DONE:{token}:{stage}:%s\\n' \"$input_status\"\n"
            ),
        ]
    }

    #[test]
    fn version_probe_returns_exact_terminal_not_found_receipt() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            receipt(&args(token, "version")).unwrap(),
            format!("uitest not found\n\nDF_INPUT_DONE:{token}:version:127\n")
        );
    }

    #[test]
    fn wrong_token_stage_or_changed_script_is_not_recognized() {
        for token in [
            "",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeg",
            "0123456789ABCDEF0123456789abcdef",
        ] {
            assert!(receipt(&args(token, "version")).is_none());
        }
        let token = "0123456789abcdef0123456789abcdef";
        for stage in ["help", "action", "enter"] {
            assert!(receipt(&args(token, stage)).is_none());
        }
        for replacement in [
            "uitest help",
            "uitest --version; reboot",
            "uitest --version extra",
        ] {
            let mut arguments = args(token, "version");
            arguments[3] = arguments[3].replace("uitest --version", replacement);
            assert!(receipt(&arguments).is_none());
        }
        let mut arguments = args(token, "version");
        arguments[3].push_str("echo late\n");
        assert!(receipt(&arguments).is_none());
    }

    #[test]
    fn android_or_wrong_argument_shape_preserves_other_fixture_branches() {
        let token = "0123456789abcdef0123456789abcdef";
        let mut arguments = args(token, "version");
        arguments[0] = "-s".into();
        assert!(receipt(&arguments).is_none());
        arguments = args(token, "version");
        arguments[2] = "exec-out".into();
        assert!(receipt(&arguments).is_none());
        arguments = args(token, "version");
        arguments.push("extra".into());
        assert!(receipt(&arguments).is_none());
    }
}
