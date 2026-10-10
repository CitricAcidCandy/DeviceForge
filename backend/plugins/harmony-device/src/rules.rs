use crate::{Error, Result};

pub(crate) fn serial(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-[]".contains(&byte))
    {
        return Err(Error::Invalid("设备标识包含不支持的字符或超过200字节"));
    }
    Ok(())
}

pub(crate) fn package(value: &str) -> Result<()> {
    if value.len() > 200
        || !value.contains('.')
        || !value.split('.').all(|part| {
            let mut bytes = part.bytes();
            bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
                && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
    {
        return Err(Error::Invalid("应用包名须为最多200字节的点分ASCII标识"));
    }
    Ok(())
}

pub(crate) fn artifact_id(value: &str) -> Result<()> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(Error::Invalid("产物ID须为标准连字符UUID"));
    }
    Ok(())
}

pub(crate) fn filename(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > 200
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', ':'])
        || matches!(value, "." | "..")
    {
        return Err(Error::Invalid("产物显示名不是有效单文件名"));
    }
    Ok(())
}

pub(crate) fn text(stdout: &[u8], stderr: &[u8]) -> Result<String> {
    let stdout =
        std::str::from_utf8(stdout).map_err(|_| Error::Dependency("HDC输出不是有效UTF-8"))?;
    let stderr =
        std::str::from_utf8(stderr).map_err(|_| Error::Dependency("HDC输出不是有效UTF-8"))?;
    let output = format!("{stdout}\n{stderr}");
    let lower = output.to_ascii_lowercase();
    if [
        "failure",
        "failed",
        "error",
        "unable",
        "cannot",
        "offline",
        "no devices",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return Err(Error::Dependency("HDC返回失败诊断"));
    }
    Ok(output.trim().to_owned())
}

pub(crate) fn success(stdout: &[u8], stderr: &[u8], install: bool) -> Result<String> {
    let output = text(stdout, stderr)?;
    let lower = output.to_ascii_lowercase();
    let suffix = if install {
        "msg:install bundle successfully."
    } else {
        "msg:uninstall bundle successfully."
    };
    if !lower.lines().any(|line| line.trim().ends_with(suffix)) {
        return Err(Error::Dependency("HDC未返回明确成功结果"));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_keep_original_hdc_ascii_qualification() {
        assert!(serial("host:5555").is_ok());
        for value in ["", "-flag", "invalid device", "设备", "serial\n"] {
            assert!(serial(value).is_err());
        }
        assert!(package("com.example.app").is_ok());
        for value in ["app", "com.1bad", "com..app"] {
            assert!(package(value).is_err());
        }
        assert!(artifact_id("d0da1b1b-919c-40a8-9c71-fbb56614e488").is_ok());
        assert!(artifact_id("../input.hap").is_err());
    }

    #[test]
    fn action_requires_correct_success_and_stderr_failure_wins() {
        assert!(success(b"[Info] msg:install bundle successfully.", b"", true).is_ok());
        assert!(success(b"MSG:UNINSTALL BUNDLE SUCCESSFULLY.", b"", false).is_ok());
        assert!(success(b"msg:uninstall bundle successfully.", b"", true).is_err());
        assert!(success(b"msg:install bundle successfully.", b"error: denied", true).is_err());
        assert!(success(b"Success", b"", true).is_err());
        assert!(text(&[0xff], b"").is_err());
    }
}
