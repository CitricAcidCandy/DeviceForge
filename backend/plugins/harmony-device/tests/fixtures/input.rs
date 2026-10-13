use std::{
    fs,
    io::{self, Write},
    path::Path,
};

fn identity(arguments: &[String]) -> (String, String) {
    assert_eq!(arguments.len(), 4, "输入只能使用四个固定HDC参数");
    assert_eq!(arguments[0], "-t");
    assert_eq!(arguments[2], "shell");
    let script = &arguments[3];
    let offset = script.rfind("DF_INPUT_DONE:").unwrap() + "DF_INPUT_DONE:".len();
    let token = script.get(offset..offset + 32).unwrap();
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert_eq!(script.as_bytes()[offset + 32], b':');
    let stage = script[offset + 33..].split(':').next().unwrap();
    assert!(matches!(stage, "version" | "help" | "action" | "enter"));
    (token.to_owned(), stage.to_owned())
}

pub fn before_ready(root: &Path, call: &Path, plan: &Path, arguments: &[String]) {
    if !root.join("input-fixture").is_file() || arguments == ["list", "targets"] {
        return;
    }
    let (token, stage) = identity(arguments);
    let expected_stage = fs::read_to_string(plan.join("input-stage")).unwrap();
    let command = fs::read_to_string(plan.join("input-command")).unwrap();
    let serial = fs::read_to_string(plan.join("input-serial")).unwrap();
    assert_eq!(stage, expected_stage);
    let expected = format!(
        "{command} 2>&1\ninput_status=$?\nprintf '\\nDF_INPUT_DONE:{token}:{expected_stage}:%s\\n' \"$input_status\"\n"
    );
    assert_eq!(arguments, ["-t", &serial, "shell", &expected]);
    fs::write(call.join("input-token"), token).unwrap();
    fs::write(call.join("input-stage"), stage).unwrap();
    fs::write(call.join("input-argv-verified"), b"1").unwrap();
}

fn substitute(bytes: &[u8], token: &str, stage: &str) -> Vec<u8> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset..].starts_with(b"{{TOKEN}}") {
            result.extend_from_slice(token.as_bytes());
            offset += b"{{TOKEN}}".len();
        } else if bytes[offset..].starts_with(b"{{STAGE}}") {
            result.extend_from_slice(stage.as_bytes());
            offset += b"{{STAGE}}".len();
        } else {
            result.push(bytes[offset]);
            offset += 1;
        }
    }
    result
}

pub fn write_response(root: &Path, call: &Path, plan: &Path, arguments: &[String]) -> Option<i32> {
    if !root.join("input-fixture").is_file() || arguments == ["list", "targets"] {
        return None;
    }
    let token = fs::read_to_string(call.join("input-token")).unwrap();
    let stage = fs::read_to_string(call.join("input-stage")).unwrap();
    let bytes = substitute(&fs::read(plan.join("stdout")).unwrap(), &token, &stage);
    fs::write(call.join("input-stdout.bin"), &bytes).unwrap();
    io::stdout().write_all(&bytes).unwrap();
    io::stdout().flush().unwrap();
    let stderr = fs::read(plan.join("stderr")).unwrap();
    io::stderr().write_all(&stderr).unwrap();
    io::stderr().flush().unwrap();
    Some(
        fs::read_to_string(plan.join("code"))
            .unwrap()
            .parse()
            .unwrap(),
    )
}
