use deviceforge_android_package_core::{Control, Error, LimitKind, TreeProfile, archive::tree};
use std::fs::{self, OpenOptions};

#[test]
fn reverse_scan_and_pack_preserve_sorted_names_sizes_and_finished_length() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("z.txt"), b"xyz").unwrap();
    fs::write(root.join("nested/a.txt"), b"alpha").unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    // 监测期机制不能提前要求 Android 最终两个必需文件。
    let snapshot = tree::scan(&root, TreeProfile::Reverse, &control).unwrap();
    assert_eq!(snapshot.profile(), TreeProfile::Reverse);
    assert_eq!(snapshot.directory().declared_size(), 8);
    let mut names = snapshot
        .directory()
        .entries()
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["nested/", "nested/a.txt", "z.txt"]);
    // 最终打包另取补齐必需成员后的快照，监测期通过不借记最终资格。
    fs::write(root.join("apktool.yml"), b"x").unwrap();
    fs::write(root.join("AndroidManifest.xml"), b"x").unwrap();
    let snapshot = tree::scan(&root, TreeProfile::Reverse, &control).unwrap();
    let output_path = temporary.path().join("packed.zip");
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    let result = tree::pack(&snapshot, &mut destination, &control).unwrap();
    assert_eq!(result.files, 4);
    assert_eq!(result.unpacked_size, 10);
    assert_eq!(
        result.entries,
        [
            "AndroidManifest.xml",
            "apktool.yml",
            "nested/a.txt",
            "z.txt"
        ]
    );
    assert_eq!(
        result.archive_size,
        fs::metadata(&output_path).unwrap().len()
    );

    // 按中央目录与 local header 独立复核 Stored 原字节，不要求 writer 的 descriptor 策略。
    let bytes = fs::read(output_path).unwrap();
    let footer = bytes.len() - 22;
    assert_eq!(&bytes[footer..footer + 4], b"PK\x05\x06");
    let count = usize::from(u16::from_le_bytes(
        bytes[footer + 10..footer + 12].try_into().unwrap(),
    ));
    assert_eq!(count, 4);
    let mut offset = usize::try_from(u32::from_le_bytes(
        bytes[footer + 16..footer + 20].try_into().unwrap(),
    ))
    .unwrap();
    let mut observed = Vec::new();
    for _ in 0..count {
        assert_eq!(&bytes[offset..offset + 4], b"PK\x01\x02");
        assert_eq!(&bytes[offset + 10..offset + 12], &[0, 0]);
        let checksum = u32::from_le_bytes(bytes[offset + 16..offset + 20].try_into().unwrap());
        let size = usize::try_from(u32::from_le_bytes(
            bytes[offset + 20..offset + 24].try_into().unwrap(),
        ))
        .unwrap();
        assert_eq!(
            size,
            usize::try_from(u32::from_le_bytes(
                bytes[offset + 24..offset + 28].try_into().unwrap()
            ))
            .unwrap()
        );
        let name_length = usize::from(u16::from_le_bytes(
            bytes[offset + 28..offset + 30].try_into().unwrap(),
        ));
        let extra_length = usize::from(u16::from_le_bytes(
            bytes[offset + 30..offset + 32].try_into().unwrap(),
        ));
        let comment_length = usize::from(u16::from_le_bytes(
            bytes[offset + 32..offset + 34].try_into().unwrap(),
        ));
        let name = std::str::from_utf8(&bytes[offset + 46..offset + 46 + name_length])
            .unwrap()
            .to_owned();
        let local = usize::try_from(u32::from_le_bytes(
            bytes[offset + 42..offset + 46].try_into().unwrap(),
        ))
        .unwrap();
        assert_eq!(&bytes[local..local + 4], b"PK\x03\x04");
        let local_name = usize::from(u16::from_le_bytes(
            bytes[local + 26..local + 28].try_into().unwrap(),
        ));
        let local_extra = usize::from(u16::from_le_bytes(
            bytes[local + 28..local + 30].try_into().unwrap(),
        ));
        assert_eq!(&bytes[local + 30..local + 30 + local_name], name.as_bytes());
        let data_start = local + 30 + local_name + local_extra;
        let data = bytes[data_start..data_start + size].to_vec();
        assert_eq!(crate::stored_zip::crc32(&data), checksum);
        observed.push((name, data));
        offset += 46 + name_length + extra_length + comment_length;
    }
    assert_eq!(
        observed,
        [
            ("AndroidManifest.xml".into(), b"x".to_vec()),
            ("apktool.yml".into(), b"x".to_vec()),
            ("nested/a.txt".into(), b"alpha".to_vec()),
            ("z.txt".into(), b"xyz".to_vec()),
        ]
    );
    assert_eq!(offset, footer);
    assert!(result.archive_size > result.unpacked_size);
}

#[test]
fn file_length_change_after_scan_is_source_changed_without_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("one.txt"), b"original").unwrap();
    fs::write(root.join("apktool.yml"), b"x").unwrap();
    fs::write(root.join("AndroidManifest.xml"), b"x").unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let snapshot = tree::scan(&root, TreeProfile::Reverse, &control).unwrap();
    fs::write(root.join("one.txt"), b"longer than the original").unwrap();
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary.path().join("packed.zip"))
        .unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut output, &control),
        Err(Error::SourceChanged)
    ));
    assert_eq!(
        fs::read(root.join("one.txt")).unwrap(),
        b"longer than the original"
    );
}

#[test]
fn pre_cancelled_tree_pack_leaves_prepared_output_empty() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("one.txt"), b"data").unwrap();
    let never_cancelled = || false;
    let open_control = Control::new(None, &never_cancelled);
    let snapshot = tree::scan(&root, TreeProfile::Reverse, &open_control).unwrap();
    let cancelled = || true;
    let stopped = Control::new(None, &cancelled);
    let output_path = temporary.path().join("packed.zip");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut output, &stopped),
        Err(Error::Cancelled)
    ));
    assert_eq!(fs::metadata(output_path).unwrap().len(), 0);
}

#[test]
fn splits_final_rejects_empty_and_non_apk_outputs_after_monitor_scan_succeeds() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    for non_apk in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("source");
        fs::create_dir(&root).unwrap();
        if non_apk {
            fs::write(root.join("unexpected.txt"), b"data").unwrap();
        }
        let snapshot = tree::scan(&root, TreeProfile::Splits, &control).unwrap();
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary.path().join("packed.zip"))
            .unwrap();
        assert!(matches!(
            tree::pack(&snapshot, &mut output, &control),
            Err(Error::InvalidArchive(
                "Splits 最终目录必须包含且仅包含 APK 文件"
            ))
        ));
    }
}

#[test]
fn splits_accepts_sorted_structural_zip_files_without_claiming_installable_apks() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    let generic_zip =
        crate::stored_zip::stored_zip(&[("ordinary.txt", b"not an Android manifest")]);
    fs::write(root.join("z.apk"), &generic_zip.bytes).unwrap();
    fs::write(root.join("a.apk"), &generic_zip.bytes).unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let snapshot = tree::scan(&root, TreeProfile::Splits, &control).unwrap();
    assert_eq!(snapshot.profile(), TreeProfile::Splits);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary.path().join("packed.zip"))
        .unwrap();
    let result = tree::pack(&snapshot, &mut output, &control).unwrap();
    assert_eq!(result.files, 2);
    assert_eq!(result.entries, ["a.apk", "z.apk"]);
    assert_eq!(
        result.unpacked_size,
        u64::try_from(generic_zip.bytes.len() * 2).unwrap()
    );
}

#[test]
fn splits_refuses_a_broken_zip_even_with_an_apk_suffix() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("bad.apk"), b"not a ZIP").unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let snapshot = tree::scan(&root, TreeProfile::Splits, &control).unwrap();
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary.path().join("packed.zip"))
        .unwrap();
    assert!(matches!(
        tree::pack(&snapshot, &mut output, &control),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn tree_entry_limits_count_directories_and_keep_profiles_distinct() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    for index in 0..1000 {
        fs::create_dir(root.join(format!("directory-{index:04}"))).unwrap();
    }
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let equal = tree::scan(&root, TreeProfile::Splits, &control).unwrap();
    assert_eq!(equal.directory().entries().len(), 1000);
    fs::write(root.join("directory-0000/one.txt"), b"data").unwrap();
    assert!(matches!(
        tree::scan(&root, TreeProfile::Splits, &control),
        Err(Error::LimitExceeded {
            kind: LimitKind::Entries,
            limit: 1000
        })
    ));
    let reverse = tree::scan(&root, TreeProfile::Reverse, &control).unwrap();
    assert_eq!(reverse.directory().entries().len(), 1001);
    assert_eq!(reverse.directory().declared_size(), 4);
}
