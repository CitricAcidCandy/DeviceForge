mod common;
use common::{input, live, stored};
use deviceforge_android_package_core::{
    ArchiveProfile, Error, LimitKind, TreeProfile,
    archive::{Archive, tree},
};
use std::{
    fs::{self, File},
    io::Read,
};

#[test]
fn monitoring_allows_partial_outputs_but_final_pack_requires_profile_contents() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()),
        Err(Error::InvalidArchive(_))
    ));
    fs::write(root.path().join("apktool.yml"), b"version: 1").unwrap();
    fs::write(root.path().join("AndroidManifest.xml"), b"<manifest/>").unwrap();
    fs::create_dir(root.path().join("smali")).unwrap();
    fs::write(root.path().join("smali/z.smali"), b"class").unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    let mut output = tempfile::tempfile().unwrap();
    let packed = tree::pack(&snapshot, &mut output, &live()).unwrap();
    assert_eq!(packed.files, 3);
    assert_eq!(
        packed.entries,
        ["AndroidManifest.xml", "apktool.yml", "smali/z.smali"]
    );
    let archive = Archive::open(output, ArchiveProfile::Structure, &live()).unwrap();
    assert_eq!(archive.directory().entries().len(), 3);
    assert!(
        archive
            .directory()
            .entries()
            .iter()
            .all(|entry| entry.size == entry.compressed_size)
    );
}

#[test]
fn split_and_reverse_counts_include_directories_and_keep_different_limits() {
    let root = tempfile::tempdir().unwrap();
    for number in 0..1001 {
        fs::create_dir(root.path().join(format!("d{number:04}"))).unwrap();
    }
    assert!(matches!(
        tree::scan(root.path(), TreeProfile::Splits, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::Entries,
            limit: 1000
        })
    ));
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    assert_eq!(snapshot.directory().entries().len(), 1001);
}

#[test]
fn splits_are_sorted_nonempty_apks_and_each_container_is_checked() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("b.apk"), stored(&[("manifest", b"b", 0)])).unwrap();
    fs::write(root.path().join("a.apk"), stored(&[("manifest", b"a", 0)])).unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Splits, &live()).unwrap();
    let packed = tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()).unwrap();
    assert_eq!(packed.entries, ["a.apk", "b.apk"]);
    fs::write(root.path().join("a.apk"), b"not zip").unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Splits, &live()).unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()),
        Err(Error::InvalidArchive(_))
    ));
    fs::write(root.path().join("a.apk"), stored(&[("manifest", b"a", 0)])).unwrap();
    fs::write(root.path().join("extra.txt"), b"x").unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Splits, &live()).unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn source_change_nonempty_destination_and_archive_overhead_do_not_succeed() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("apktool.yml"), b"x").unwrap();
    fs::write(root.path().join("AndroidManifest.xml"), b"y").unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    fs::write(root.path().join("apktool.yml"), b"changed").unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()),
        Err(Error::SourceChanged)
    ));
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut input(b"occupied"), &live()),
        Err(Error::InvalidArgument(_))
    ));
    let file = File::create(root.path().join("large")).unwrap();
    file.set_len(64 * 1024 * 1024 - 16).unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut tempfile::tempfile().unwrap(), &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::ArchiveBytes,
            ..
        })
    ));
}

#[test]
fn scan_rejects_links_and_expired_control_before_path_access() {
    use std::time::{Duration, Instant};
    let expired = deviceforge_android_package_core::Control::new(
        Some(Instant::now() - Duration::from_secs(1)),
        &|| false,
    );
    assert!(matches!(
        tree::scan(
            std::path::Path::new("path-that-does-not-exist"),
            TreeProfile::Reverse,
            &expired
        ),
        Err(Error::Timeout)
    ));
    #[cfg(unix)]
    {
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("missing", root.path().join("link")).unwrap();
        assert!(matches!(
            tree::scan(root.path(), TreeProfile::Reverse, &live()),
            Err(Error::InvalidArchive(_))
        ));
    }
}

#[test]
fn stored_pack_reads_back_exact_file_content() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("a.apk"),
        stored(&[("payload", b"value", 0)]),
    )
    .unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Splits, &live()).unwrap();
    let mut output = tempfile::tempfile().unwrap();
    tree::pack(&snapshot, &mut output, &live()).unwrap();
    let mut archive = Archive::open(output, ArchiveProfile::Structure, &live()).unwrap();
    let mut selected = tempfile::tempfile().unwrap();
    archive
        .select_exact("a.apk", &live())
        .unwrap()
        .copy_to(&mut selected, 65536, &live())
        .unwrap();
    use std::io::{Seek, SeekFrom};
    selected.seek(SeekFrom::Start(0)).unwrap();
    let mut actual = Vec::new();
    selected.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, stored(&[("payload", b"value", 0)]));
}

#[test]
fn depth_cap_and_interrupted_pack_do_not_return_summary() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let deep_root = tempfile::tempdir().unwrap();
    let mut path = deep_root.path().to_path_buf();
    for _ in 0..129 {
        path.push("d");
        fs::create_dir(&path).unwrap();
    }
    assert!(matches!(
        tree::scan(deep_root.path(), TreeProfile::Reverse, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::Depth,
            limit: 128
        })
    ));
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("apktool.yml"), b"x").unwrap();
    fs::write(root.path().join("AndroidManifest.xml"), b"y").unwrap();
    fs::write(root.path().join("payload"), vec![7; 200_000]).unwrap();
    let snapshot = tree::scan(root.path(), TreeProfile::Reverse, &live()).unwrap();
    let checks = AtomicUsize::new(0);
    let observe = || {
        checks.fetch_add(1, Ordering::Relaxed);
        false
    };
    let packed = tree::pack(
        &snapshot,
        &mut tempfile::tempfile().unwrap(),
        &deviceforge_android_package_core::Control::new(None, &observe),
    )
    .unwrap();
    let total_checks = checks.load(Ordering::Relaxed);
    let checks = AtomicUsize::new(0);
    let cancel = || checks.fetch_add(1, Ordering::Relaxed) >= total_checks / 2;
    let mut target = tempfile::tempfile().unwrap();
    assert!(matches!(
        tree::pack(
            &snapshot,
            &mut target,
            &deviceforge_android_package_core::Control::new(None, &cancel)
        ),
        Err(Error::Cancelled)
    ));
    assert!(target.metadata().unwrap().len() <= packed.archive_size);
}
