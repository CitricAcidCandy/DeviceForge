use crate::{Error, Result, rules};

pub(crate) fn ability(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || !value.split('.').all(|part| {
            let mut bytes = part.bytes();
            bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
                && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
    {
        return Err(Error::Invalid("Ability名称须为最多200字节的ASCII标识"));
    }
    Ok(())
}

pub(crate) fn success_line(stdout: &[u8], stderr: &[u8], expected: &str) -> Result<String> {
    let output = rules::text(stdout, stderr)?;
    if !output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(expected))
    {
        return Err(Error::Dependency("HDC未返回明确成功结果"));
    }
    Ok(output)
}
