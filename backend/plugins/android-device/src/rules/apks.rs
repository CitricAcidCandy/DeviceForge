//! APKS 旧成功资格与公共包错误映射；不执行工具或读取文件。
use crate::{Error, Result};
use deviceforge_android_package_core::{Error as PackageError, LimitKind};

pub(crate) fn install_output(stdout: &[u8], stderr: &[u8]) -> Result<()> {
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let lower = output.to_ascii_lowercase();
    if [
        "failure",
        "failed",
        "error",
        "unable",
        "cannot",
        "offline",
        "unauthorized",
        "no devices",
        "incompatible",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return Err(Error::Dependency("APKS工具返回失败诊断"));
    }
    Ok(())
}

pub(crate) fn package_error(error: PackageError) -> Error {
    match error {
        PackageError::Cancelled => Error::Cancelled,
        PackageError::Timeout => Error::Timeout,
        PackageError::LimitExceeded {
            kind: LimitKind::Entries,
            ..
        } => Error::Invalid("APKS成员超过10000条"),
        PackageError::LimitExceeded { .. } => Error::TooLarge,
        PackageError::Io { .. } => Error::Io("APKS归档无法读取"),
        PackageError::SourceChanged => Error::Invalid("APKS校验源文件发生变化"),
        _ => Error::Invalid("APKS外层结构、成员长度或CRC无效"),
    }
}

pub(crate) fn structure_error(error: PackageError) -> Error {
    match error {
        PackageError::LimitExceeded {
            kind: LimitKind::ExpandedBytes,
            ..
        } => Error::Invalid("APKS结构声明解压体积超过2GiB"),
        other => package_error(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_lossy_outputs_keep_the_original_zero_exit_success_rule() {
        for (stdout, stderr) in [
            (b"".as_slice(), b"".as_slice()),
            (b"done\n".as_slice(), &[0xff]),
            (&[0xff], b"".as_slice()),
        ] {
            assert!(install_output(stdout, stderr).is_ok());
        }
    }

    #[test]
    fn failure_in_either_stream_wins_without_requiring_a_success_line() {
        for word in [
            "Failure",
            "FAILED",
            "error",
            "unable",
            "cannot",
            "offline",
            "unauthorized",
            "no devices",
            "incompatible",
        ] {
            assert!(install_output(word.as_bytes(), b"Success").is_err());
            assert!(install_output(b"Success", word.as_bytes()).is_err());
        }
    }

    #[test]
    fn public_package_control_and_limits_keep_their_categories() {
        assert!(matches!(
            package_error(PackageError::Cancelled),
            Error::Cancelled
        ));
        assert!(matches!(
            package_error(PackageError::Timeout),
            Error::Timeout
        ));
        assert!(matches!(
            package_error(PackageError::LimitExceeded {
                kind: LimitKind::Entries,
                limit: 10000
            }),
            Error::Invalid(_)
        ));
        assert!(matches!(
            package_error(PackageError::LimitExceeded {
                kind: LimitKind::ExpandedBytes,
                limit: 256 * 1024 * 1024
            }),
            Error::TooLarge
        ));
        assert!(matches!(
            structure_error(PackageError::LimitExceeded {
                kind: LimitKind::ExpandedBytes,
                limit: 2 * 1024 * 1024 * 1024
            }),
            Error::Invalid(_)
        ));
    }
}
