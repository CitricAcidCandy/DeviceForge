use super::*;
use crate::config::Source;
use serde_json::json;
use std::{
    cell::Cell,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

fn budget() -> Budget {
    Budget {
        deadline: Instant::now() + Duration::from_secs(10),
        cancel: CancellationToken::new(),
    }
}

fn config(root: &Path) -> Config {
    Config {
        source: Source::Url("http://127.0.0.1:1/manifest".into()),
        manifest_cache_enabled: true,
        root: fs::canonicalize(root).unwrap(),
        allow_http: true,
        download_limit: MANIFEST_LIMIT,
        extracted_limit: MANIFEST_LIMIT,
        file_limit: 100,
        repository: None,
    }
}

fn manifest(version: &str) -> Manifest {
    serde_json::from_value(json!({"manifestVersion":version,"modules":[]})).unwrap()
}

fn seeded(config: &Config) -> (String, Vec<u8>) {
    let identity = source_digest("http://127.0.0.1:1/manifest").unwrap();
    write(config, &identity, &manifest("first"), &budget()).unwrap();
    let path = config
        .root
        .join(".manifest-cache")
        .join(format!("{identity}.json"));
    (identity, fs::read(path).unwrap())
}

#[test]
fn canonical_identity_includes_defaults_content_and_module_order_not_just_version() {
    let first = manifest("same");
    let expected =
        br#"{"manifestVersion":"same","generatedAt":"","minAppVersion":null,"modules":[]}"#;
    assert_eq!(canonical(&first).unwrap(), expected);
    assert_eq!(
        digest(&first).unwrap(),
        format!("{:x}", Sha256::digest(expected))
    );
    let reordered: Manifest =
        serde_json::from_slice(br#"{"modules":[], "manifest_version":"same"}"#).unwrap();
    assert_eq!(digest(&first).unwrap(), digest(&reordered).unwrap());
    let mut changed = first.clone();
    changed.generated_at = "another".into();
    assert_ne!(digest(&first).unwrap(), digest(&changed).unwrap());
    let mut multiple: Manifest = serde_json::from_value(json!({
        "manifestVersion":"same", "modules":[
            {"name":"first","version":"1","url":"https://example.invalid/first",
                "sha256":"0".repeat(64),"size":1},
            {"name":"second","version":"1","url":"https://example.invalid/second",
                "sha256":"1".repeat(64),"size":1}
        ]
    }))
    .unwrap();
    let original = digest(&multiple).unwrap();
    multiple.modules.reverse();
    assert_ne!(original, digest(&multiple).unwrap());
}

#[test]
fn source_identity_normalizes_url_but_includes_query() {
    assert_eq!(
        source_digest("HTTP://EXAMPLE.COM:80/catalog?key=1").unwrap(),
        source_digest("http://example.com/catalog?key=1").unwrap()
    );
    assert_ne!(
        source_digest("http://example.com/catalog?key=1").unwrap(),
        source_digest("http://example.com/catalog?key=2").unwrap()
    );
}

#[test]
fn missing_cache_does_not_create_directory_and_disabled_config_does_not_delete_it() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let identity = source_digest("http://127.0.0.1:1/manifest").unwrap();
    assert!(read(&config, &identity, &budget()).unwrap().is_none());
    assert!(!config.root.join(".manifest-cache").exists());
    let (identity, bytes) = seeded(&config);
    let mut disabled = config.clone();
    disabled.manifest_cache_enabled = false;
    assert_eq!(
        fs::read(
            disabled
                .root
                .join(".manifest-cache")
                .join(format!("{identity}.json"))
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn cache_envelope_identity_corruption_and_current_qualification_are_hard_errors() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let (identity, original) = seeded(&config);
    let path = config
        .root
        .join(".manifest-cache")
        .join(format!("{identity}.json"));
    for (field, value) in [
        ("schema_version", json!(2)),
        ("source_sha256", json!("1".repeat(64))),
        ("manifest_sha256", json!("2".repeat(64))),
        ("manifest", json!({"manifestVersion":"","modules":[]})),
    ] {
        let mut envelope: serde_json::Value = serde_json::from_slice(&original).unwrap();
        envelope[field] = value;
        fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        assert!(matches!(
            read(&config, &identity, &budget()),
            Err(Error::Invalid(_))
        ));
    }
    fs::write(&path, b"not-json").unwrap();
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::Invalid(_))
    ));
    fs::write(&path, &original).unwrap();
    let mut restrictive = config.clone();
    restrictive.download_limit = 0;
    let qualified: Manifest = serde_json::from_value(json!({"manifestVersion":"first","modules":[
        {"name":"sdk","version":"1","url":"https://example.invalid/sdk",
            "sha256":"0".repeat(64),"size":1}
    ]}))
    .unwrap();
    write(&config, &identity, &qualified, &budget()).unwrap();
    assert!(matches!(
        read(&restrictive, &identity, &budget()),
        Err(Error::TooLarge)
    ));
}

#[test]
fn cache_payload_and_envelope_limits_remain_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let (identity, _) = seeded(&config);
    let path = config
        .root
        .join(".manifest-cache")
        .join(format!("{identity}.json"));
    fs::write(path, vec![b' '; ENVELOPE_LIMIT as usize + 1]).unwrap();
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::TooLarge)
    ));
    let mut oversized = manifest("large");
    oversized.generated_at = "x".repeat(MANIFEST_LIMIT as usize);
    assert!(matches!(canonical(&oversized), Err(Error::TooLarge)));
}

#[test]
fn metadata_io_non_regular_objects_and_lock_busy_are_not_misses() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = config(directory.path());
    let (identity, _) = seeded(&config);
    let lock = CacheLock::acquire(&config, &identity, false, &budget())
        .unwrap()
        .unwrap();
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::CacheBusy)
    ));
    drop(lock);
    let snapshot = config
        .root
        .join(".manifest-cache")
        .join(format!("{identity}.json"));
    fs::remove_file(&snapshot).unwrap();
    fs::create_dir(&snapshot).unwrap();
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::Invalid(_))
    ));
    config.root = config.root.join("bad\0root");
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::Io(_))
    ));
}

#[test]
fn precommit_cancel_timeout_and_io_keep_old_snapshot_and_confirm_temp_cleanup() {
    for failure in ["cancel", "timeout", "io"] {
        let directory = tempfile::tempdir().unwrap();
        let config = config(directory.path());
        let (identity, old) = seeded(&config);
        let lock = CacheLock::acquire(&config, &identity, false, &budget())
            .unwrap()
            .unwrap();
        let calls = Cell::new(0);
        let result = lock.write_checked(&manifest("second"), &|| {
            calls.set(calls.get() + 1);
            if calls.get() == 4 {
                return Err(match failure {
                    "cancel" => Error::Cancelled,
                    "timeout" => Error::Timeout,
                    _ => Error::Io("合成提交前IO失败"),
                });
            }
            Ok(())
        });
        assert!(matches!(
            (failure, result),
            ("cancel", Err(Error::Cancelled))
                | ("timeout", Err(Error::Timeout))
                | ("io", Err(Error::Io(_)))
        ));
        assert_eq!(fs::read(lock.snapshot()).unwrap(), old);
        assert!(!lock.pending().exists());
    }
}

#[test]
fn write_flush_and_sync_failures_are_distinct_hard_io_errors() {
    struct FailingWriter {
        stage: &'static str,
    }
    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.stage == "write" {
                Err(std::io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(bytes.len())
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.stage == "flush" {
                Err(std::io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(())
            }
        }
    }
    for (stage, message) in [
        ("write", "写入清单缓存失败"),
        ("flush", "刷新清单缓存失败"),
        ("sync", "持久化清单缓存失败"),
    ] {
        let result = write_bytes(&mut FailingWriter { stage }, b"synthetic", &|writer| {
            if writer.stage == "sync" {
                Err(std::io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(Error::Io(actual)) if actual == message));
    }
}

#[test]
fn pending_cleanup_failure_is_cleanup_and_blocks_later_cache_access() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let (identity, old) = seeded(&config);
    let lock = CacheLock::acquire(&config, &identity, false, &budget())
        .unwrap()
        .unwrap();
    let calls = Cell::new(0);
    let result = lock.write_checked(&manifest("second"), &|| {
        calls.set(calls.get() + 1);
        if calls.get() == 4 {
            fs::write(lock.pending().join("obstacle"), b"synthetic").unwrap();
            return Err(Error::Cancelled);
        }
        Ok(())
    });
    assert!(matches!(result, Err(Error::Cleanup)));
    assert_eq!(fs::read(lock.snapshot()).unwrap(), old);
    let pending = lock.pending();
    drop(lock);
    assert!(matches!(
        read(&config, &identity, &budget()),
        Err(Error::Cleanup)
    ));
    fs::remove_file(pending.join("obstacle")).unwrap();
    fs::remove_dir(pending).unwrap();
    assert_eq!(
        read(&config, &identity, &budget())
            .unwrap()
            .unwrap()
            .manifest_version,
        "first"
    );
}

#[test]
fn actual_atomic_publish_failure_preserves_target_and_closes_temporary() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("existing-directory");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("old"), b"original").unwrap();
    let temporary = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
    let temporary_path = temporary.path().to_owned();
    assert!(matches!(
        commit(temporary, &target, b"replacement", &|| Ok(())),
        Err(Error::Io("清单缓存提交失败，保留原快照"))
    ));
    assert_eq!(fs::read(target.join("old")).unwrap(), b"original");
    assert!(!temporary_path.exists());
}

#[cfg(windows)]
#[test]
fn windows_sharing_denial_preserves_actual_old_snapshot_on_persist_failure() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let (identity, old) = seeded(&config);
    let lock = CacheLock::acquire(&config, &identity, false, &budget())
        .unwrap()
        .unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(lock.snapshot())
        .unwrap();
    assert!(matches!(
        lock.write(&manifest("second"), &budget()),
        Err(Error::Io("清单缓存提交失败，保留原快照"))
    ));
    assert_eq!(fs::read(lock.snapshot()).unwrap(), old);
    assert!(!lock.pending().exists());
    drop(held);
    lock.write(&manifest("second"), &budget()).unwrap();
    assert_eq!(
        lock.read(&config, &budget())
            .unwrap()
            .unwrap()
            .manifest_version,
        "second"
    );
}

#[test]
fn postcommit_cancel_is_failure_without_claiming_old_snapshot_remains() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(directory.path());
    let (identity, _) = seeded(&config);
    let lock = CacheLock::acquire(&config, &identity, false, &budget())
        .unwrap()
        .unwrap();
    let calls = Cell::new(0);
    let result = lock.write_checked(&manifest("second"), &|| {
        calls.set(calls.get() + 1);
        if calls.get() == 5 {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    });
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(!lock.pending().exists());
    assert_eq!(
        lock.read(&config, &budget())
            .unwrap()
            .unwrap()
            .manifest_version,
        "second"
    );
}

#[cfg(unix)]
#[test]
fn linked_cache_directory_snapshot_and_lock_are_rejected() {
    use std::os::unix::fs::symlink;
    for name in ["directory", "snapshot", "lock"] {
        let directory = tempfile::tempdir().unwrap();
        let config = config(directory.path());
        let (identity, _) = seeded(&config);
        let cache_directory = config.root.join(".manifest-cache");
        let (path, other) = match name {
            "directory" => (cache_directory.clone(), config.root.join("other-directory")),
            "snapshot" => (
                cache_directory.join(format!("{identity}.json")),
                config.root.join("other-snapshot"),
            ),
            _ => (
                cache_directory.join(format!("{identity}.lock")),
                config.root.join("other-lock"),
            ),
        };
        fs::rename(&path, &other).unwrap();
        symlink(other, path).unwrap();
        assert!(matches!(
            read(&config, &identity, &budget()),
            Err(Error::Invalid(_))
        ));
    }
}
