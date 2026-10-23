//! 发布提交前后中断的恢复行为；不以删除日志替代恢复。
use super::*;

fn record(revision: char) -> InstalledRelease {
    InstalledRelease {
        id: "sample".into(),
        version: "1.0".into(),
        name: "测试".into(),
        description: "恢复测试".into(),
        revision: revision.to_string().repeat(64),
        enabled: false,
        status: InstallationStatus::Installed,
        failure: None,
        installed_at: 0,
        components: vec![InstalledComponent {
            id: "browser".into(),
            kind: apk_domain::plugin_packages::PackageKind::Browser,
            version: "1.0".into(),
            revision: revision.to_string().repeat(64),
            entry_path: "dist/index.js".into(),
            entry_url: None,
        }],
        tools: vec![],
        requirements: vec![],
    }
}

#[test]
fn interrupted_transaction_restores_all_active_files_and_record() {
    let directory = tempfile::tempdir().unwrap();
    let root = paths::open_root(directory.path()).unwrap();
    for path in [
        "installations/releases",
        "installations/transactions",
        "browser-plugins/browser",
    ] {
        paths::create_directory(&root, path).unwrap();
    }
    let old = record('a');
    let new = record('b');
    paths::write(&storage::record_path(&root, "sample"), &old).unwrap();
    for relative in active_paths(&old) {
        paths::write_bytes(&root.join(relative), b"old-value").unwrap();
    }
    let journal = Journal {
        id: "sample".into(),
        revision: Some(new.revision.clone()),
        previous: Some(old.clone()),
        target: Some(new.clone()),
        files: capture(&root, Some(&old), Some(&new)).unwrap(),
    };
    paths::write(&journal_path(&root), &journal).unwrap();
    paths::write_bytes(
        &root.join("browser-plugins/browser/manifest.json"),
        b"partial-new-value",
    )
    .unwrap();
    recover(&root).unwrap();
    assert_eq!(
        storage::read_optional(&root, "sample")
            .unwrap()
            .unwrap()
            .revision,
        old.revision
    );
    for relative in active_paths(&old) {
        assert_eq!(fs::read(root.join(relative)).unwrap(), b"old-value");
    }
    assert_eq!(
        fs::read_dir(root.join("installations/transactions"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn committed_transaction_keeps_new_state_and_rejects_nonactive_recovery_path() {
    let directory = tempfile::tempdir().unwrap();
    let root = paths::open_root(directory.path()).unwrap();
    for path in [
        "installations/releases",
        "installations/transactions",
        "browser-plugins/browser",
    ] {
        paths::create_directory(&root, path).unwrap();
    }
    let old = record('a');
    let new = record('b');
    paths::write(&storage::record_path(&root, "sample"), &new).unwrap();
    for relative in active_paths(&new) {
        paths::write_bytes(&root.join(relative), b"new-value").unwrap();
    }
    let mut journal = Journal {
        id: "sample".into(),
        revision: Some(new.revision.clone()),
        previous: Some(old),
        target: Some(new.clone()),
        files: capture(&root, Some(&new), None).unwrap(),
    };
    paths::write(&journal_path(&root), &journal).unwrap();
    recover(&root).unwrap();
    assert_eq!(
        storage::read_optional(&root, "sample")
            .unwrap()
            .unwrap()
            .revision,
        new.revision
    );
    journal
        .files
        .insert("browser-plugins/browser/private.txt".into(), Some(vec![]));
    assert!(validate_journal(&journal).is_err());
}
