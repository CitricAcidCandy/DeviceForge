use crate::{Error, Result};

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

pub(crate) fn png(header: &[u8; 24], size: u64) -> Result<()> {
    if size < 45
        || &header[..8] != b"\x89PNG\r\n\x1a\n"
        || &header[8..16] != b"\0\0\0\rIHDR"
        || header[16..20] == [0; 4]
        || header[20..24] == [0; 4]
    {
        return Err(Error::Invalid("PNG标识、IHDR或尺寸无效"));
    }
    Ok(())
}

pub(crate) fn install_output(stdout: &[u8], stderr: &[u8]) -> Result<String> {
    let stdout =
        std::str::from_utf8(stdout).map_err(|_| Error::Dependency("ADB安装输出不是有效UTF-8"))?;
    let stderr =
        std::str::from_utf8(stderr).map_err(|_| Error::Dependency("ADB安装输出不是有效UTF-8"))?;
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
        || !output.lines().any(|line| line.trim() == "Success")
    {
        return Err(Error::Dependency("ADB安装未返回明确成功结果"));
    }
    Ok(output.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_uuid_format_is_required() {
        assert!(artifact_id("d0da1b1b-919c-40a8-9c71-fbb56614e488").is_ok());
        for value in [
            "d0da1b1b919c40a89c71fbb56614e488",
            "d0da1b1b-919c-40a8-9c71-fbb56614e48g",
            "{d0da1b1b-919c-40a8-9c71-fbb56614e488}",
        ] {
            assert!(artifact_id(value).is_err());
        }
    }

    #[test]
    fn installation_requires_success_and_failure_in_either_stream_wins() {
        assert_eq!(
            install_output(b" streamed\nSuccess\n", b"").unwrap(),
            "streamed\nSuccess"
        );
        for (stdout, stderr) in [
            (b"Success".as_slice(), b"Failure [DENIED]".as_slice()),
            (b"OK".as_slice(), b"".as_slice()),
            (b"Success".as_slice(), &[0xff]),
        ] {
            assert!(install_output(stdout, stderr).is_err());
        }
    }

    #[test]
    fn png_requires_ihdr_size_and_nonzero_dimensions() {
        let mut header = [0; 24];
        header[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
        header[19] = 1;
        header[23] = 1;
        assert!(png(&header, 45).is_ok());
        assert!(png(&header, 44).is_err());
        header[19] = 0;
        assert!(png(&header, 45).is_err());
        header[19] = 1;
        header[12] = b'X';
        assert!(png(&header, 45).is_err());
    }
}
