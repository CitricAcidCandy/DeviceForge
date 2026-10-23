use super::*;
use std::io::{Error as IoError, ErrorKind};

#[test]
fn optional_metadata_only_treats_not_found_as_absent() {
    for message in ["检查模块目标失败", "检查模块锁失败", "检查模块安装事务失败"]
    {
        assert!(
            optional_metadata(Err(IoError::from(ErrorKind::NotFound)), message)
                .unwrap()
                .is_none()
        );
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::Other,
            ErrorKind::InvalidInput,
        ] {
            assert!(matches!(
                optional_metadata(Err(IoError::new(kind, "合成元数据错误")), message),
                Err(Error::Io(actual)) if actual == message
            ));
        }
    }
    let directory = tempfile::tempdir().unwrap();
    assert!(
        optional_metadata(fs::symlink_metadata(directory.path()), "检查模块目标失败")
            .unwrap()
            .unwrap()
            .is_dir()
    );
}

#[test]
fn target_and_installed_reject_real_oversized_component_metadata_errors() {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path())
        .unwrap()
        .join("bad\0root");
    let config = Config {
        source: crate::config::Source::Local(directory.path().join("manifest.json")),
        manifest_cache_enabled: false,
        root,
        allow_http: false,
        download_limit: 1024,
        extracted_limit: 1024,
        file_limit: 10,
        repository: None,
    };
    let raw = fs::symlink_metadata(config.root.join("sdk")).unwrap_err();
    assert_eq!(raw.kind(), ErrorKind::InvalidInput);
    assert!(matches!(
        target(&config, "sdk"),
        Err(Error::Io("检查模块目标失败"))
    ));
    let budget = Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        cancel: tokio_util::sync::CancellationToken::new(),
    };
    assert!(matches!(
        installed(&config, "sdk", &budget),
        Err(Error::Io("检查模块目标失败"))
    ));
}
