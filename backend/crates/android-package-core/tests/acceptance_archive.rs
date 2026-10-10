#[path = "acceptance_support/deflate_zip.rs"]
// 其余坏流变体由独立 Deflate 套件覆盖，本套件只复用合法固定原件。
#[allow(dead_code)]
mod deflate_zip;
#[path = "acceptance_support/stored_zip.rs"]
mod stored_zip;
#[path = "acceptance_support/tree_cases.rs"]
mod tree_cases;

use deviceforge_android_package_core::{
    ArchiveProfile, Control, Error, LimitKind,
    archive::{Archive, ArchiveEntry},
};
use std::{
    fs::{self, File, OpenOptions},
    time::{Duration, Instant},
};
use stored_zip::{crc32, stored_zip};

fn open_archive(directory: &tempfile::TempDir, bytes: &[u8], control: &Control<'_>) -> Archive {
    let path = directory.path().join("input.zip");
    fs::write(&path, bytes).unwrap();
    Archive::open(
        File::open(path).unwrap(),
        ArchiveProfile::Structure,
        control,
    )
    .unwrap()
}

fn new_output(directory: &tempfile::TempDir) -> File {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.path().join("output.apk"))
        .unwrap()
}

#[test]
fn fixture_crc_matches_independent_fixed_vectors() {
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    assert_eq!(crc32(b""), 0);
}

#[test]
fn stored_fixture_offsets_and_headers_match_the_fixed_layout() {
    let fixture = stored_zip(&[("a.apk", b"123456789"), ("b.apk", b"123456789")]);
    // 固定尺寸独立于构造器返回的偏移，防止坏夹具掩盖 CRC/重复选择用例。
    assert_eq!(fixture.bytes.len(), 212);
    assert_eq!(fixture.directory_offset, 88);
    assert_eq!(fixture.footer_offset, 190);
    assert_eq!(fixture.members.len(), 2);
    for (index, (name, local, payload, central)) in [("a.apk", 0, 35, 88), ("b.apk", 44, 79, 139)]
        .into_iter()
        .enumerate()
    {
        let member = &fixture.members[index];
        assert_eq!(member.name, name);
        assert_eq!(member.local_header, local);
        assert_eq!(member.payload, payload);
        assert_eq!(member.central_header, central);
        assert_eq!(&fixture.bytes[local..local + 4], b"PK\x03\x04");
        assert_eq!(&fixture.bytes[payload..payload + 9], b"123456789");
        assert_eq!(&fixture.bytes[central..central + 4], b"PK\x01\x02");
        assert_eq!(
            &fixture.bytes[local + 14..local + 18],
            &0xcbf4_3926u32.to_le_bytes()
        );
        assert_eq!(
            &fixture.bytes[central + 16..central + 20],
            &0xcbf4_3926u32.to_le_bytes()
        );
    }
    assert_eq!(&fixture.bytes[190..194], b"PK\x05\x06");
    assert_eq!(&fixture.bytes[198..202], &[2, 0, 2, 0]);
    assert_eq!(&fixture.bytes[202..206], &102u32.to_le_bytes());
    assert_eq!(&fixture.bytes[206..210], &88u32.to_le_bytes());
    assert_eq!(&fixture.bytes[210..212], &[0, 0]);
}

#[test]
fn directory_keeps_duplicates_but_exact_selection_rejects_zero_and_many() {
    let temporary = tempfile::tempdir().unwrap();
    let fixture = stored_zip(&[
        ("same.apk", b"first"),
        ("same.apk", b"second"),
        ("unique.apk", b"unique"),
    ]);
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    let mut observed = archive.directory().entries().to_vec();
    observed.sort_by(|a, b| a.name.cmp(&b.name).then(a.size.cmp(&b.size)));
    assert_eq!(
        observed,
        [
            ArchiveEntry {
                name: "same.apk".into(),
                size: 5,
                compressed_size: 5,
                directory: false
            },
            ArchiveEntry {
                name: "same.apk".into(),
                size: 6,
                compressed_size: 6,
                directory: false
            },
            ArchiveEntry {
                name: "unique.apk".into(),
                size: 6,
                compressed_size: 6,
                directory: false
            },
        ]
    );
    assert_eq!(archive.directory().declared_size(), 17);
    assert!(matches!(
        archive.select_exact("missing.apk", &control),
        Err(Error::EntryMissing)
    ));
    assert!(matches!(
        archive.select_exact("same.apk", &control),
        Err(Error::EntryDuplicate)
    ));
    assert!(!temporary.path().join("output.apk").exists());

    let selected = archive.select_exact("unique.apk", &control).unwrap();
    let result = selected
        .copy_to(&mut new_output(&temporary), 6, &control)
        .unwrap();
    assert_eq!(result.name, "unique.apk");
    assert_eq!(result.bytes, 6);
    assert_eq!(
        fs::read(temporary.path().join("output.apk")).unwrap(),
        b"unique"
    );
}

#[test]
fn corrupted_selected_member_fails_crc_after_structural_open() {
    let temporary = tempfile::tempdir().unwrap();
    let mut fixture = stored_zip(&[("selected.apk", b"123456789"), ("other.apk", b"unchanged")]);
    fixture.bytes[fixture.members[0].payload] ^= 1;
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    let selected = archive.select_exact("selected.apk", &control).unwrap();
    assert!(matches!(
        selected.copy_to(&mut new_output(&temporary), 9, &control),
        Err(Error::InvalidArchive(_))
    ));
    // 失败半文件由调用方拥有，目录存在不代表任何外部资源排空。
    assert!(temporary.path().exists());
}

#[test]
fn corrupted_unselected_member_does_not_prevent_valid_exact_copy() {
    let temporary = tempfile::tempdir().unwrap();
    let mut fixture = stored_zip(&[("selected.apk", b"123456789"), ("other.apk", b"corrupt-me")]);
    fixture.bytes[fixture.members[1].payload] ^= 1;
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    let selected = archive.select_exact("selected.apk", &control).unwrap();
    let result = selected
        .copy_to(&mut new_output(&temporary), 9, &control)
        .unwrap();
    assert_eq!(result.name, "selected.apk");
    assert_eq!(result.bytes, 9);
    assert_eq!(
        fs::read(temporary.path().join("output.apk")).unwrap(),
        b"123456789"
    );
}

#[test]
fn exact_output_limit_accepts_equality_and_rejects_one_extra_byte() {
    let fixture = stored_zip(&[("selected.apk", b"123456789")]);
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    for (limit, succeeds) in [(9, true), (8, false)] {
        let temporary = tempfile::tempdir().unwrap();
        let mut archive = open_archive(&temporary, &fixture.bytes, &control);
        let result = archive
            .select_exact("selected.apk", &control)
            .unwrap()
            .copy_to(&mut new_output(&temporary), limit, &control);
        if succeeds {
            assert_eq!(result.unwrap().bytes, 9);
            assert_eq!(
                fs::read(temporary.path().join("output.apk")).unwrap(),
                b"123456789"
            );
        } else {
            assert!(matches!(
                result,
                Err(Error::LimitExceeded {
                    kind: LimitKind::FileBytes,
                    limit: 8
                })
            ));
        }
    }
}

#[test]
fn unsafe_names_and_directory_selection_are_exact_argument_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let fixture = stored_zip(&[("selected.apk", b"data"), ("folder/", b"")]);
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    for name in [
        "../escape.apk",
        "/escape.apk",
        "a\\b.apk",
        "a:b.apk",
        "folder/",
    ] {
        assert!(
            matches!(
                archive.select_exact(name, &control),
                Err(Error::InvalidArgument(_))
            ),
            "名称：{name}"
        );
    }
    assert!(!temporary.path().join("output.apk").exists());
}

#[test]
fn pre_cancelled_and_expired_copy_leave_the_prepared_target_empty() {
    let fixture = stored_zip(&[("selected.apk", b"123456789")]);
    let never_cancelled = || false;
    let open_control = Control::new(None, &never_cancelled);
    for expired in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let mut archive = open_archive(&temporary, &fixture.bytes, &open_control);
        let selected = archive.select_exact("selected.apk", &open_control).unwrap();
        let cancelled = || true;
        let stop_control = Control::new(
            expired.then(|| Instant::now() - Duration::from_secs(1)),
            &cancelled,
        );
        let result = selected.copy_to(&mut new_output(&temporary), 9, &stop_control);
        if expired {
            assert!(matches!(result, Err(Error::Timeout)));
        } else {
            assert!(matches!(result, Err(Error::Cancelled)));
        }
        assert_eq!(
            fs::metadata(temporary.path().join("output.apk"))
                .unwrap()
                .len(),
            0
        );
    }
}

#[test]
fn structural_bad_footer_split_volume_and_zip64_are_exact_archive_errors() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let fixture = stored_zip(&[("safe.apk", b"data")]);
    let mut truncated = fixture.bytes.clone();
    truncated.pop();
    let mut volume = fixture.bytes.clone();
    volume[fixture.footer_offset + 4..fixture.footer_offset + 6]
        .copy_from_slice(&1u16.to_le_bytes());
    let mut out_of_range = fixture.bytes.clone();
    out_of_range[fixture.footer_offset + 16..fixture.footer_offset + 20]
        .copy_from_slice(&u32::MAX.to_le_bytes());
    let mut zip64 = fixture.bytes.clone();
    // 构造完整 ZIP64 EOCD 与 locator；小条目也可以使用扩展目录记录。
    let mut extension = b"PK\x06\x06".to_vec();
    extension.extend_from_slice(&44u64.to_le_bytes());
    extension.extend_from_slice(&45u16.to_le_bytes());
    extension.extend_from_slice(&45u16.to_le_bytes());
    extension.extend_from_slice(&0u32.to_le_bytes());
    extension.extend_from_slice(&0u32.to_le_bytes());
    extension.extend_from_slice(&1u64.to_le_bytes());
    extension.extend_from_slice(&1u64.to_le_bytes());
    extension.extend_from_slice(
        &u64::try_from(fixture.footer_offset - fixture.directory_offset)
            .unwrap()
            .to_le_bytes(),
    );
    extension.extend_from_slice(
        &u64::try_from(fixture.directory_offset)
            .unwrap()
            .to_le_bytes(),
    );
    let mut locator = b"PK\x06\x07".to_vec();
    locator.extend_from_slice(&0u32.to_le_bytes());
    locator.extend_from_slice(&u64::try_from(fixture.footer_offset).unwrap().to_le_bytes());
    locator.extend_from_slice(&1u32.to_le_bytes());
    extension.extend_from_slice(&locator);
    zip64.splice(fixture.footer_offset..fixture.footer_offset, extension);
    for bytes in [truncated, volume, out_of_range, zip64] {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("bad.zip");
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            Archive::open(
                File::open(path).unwrap(),
                ArchiveProfile::Structure,
                &control
            ),
            Err(Error::InvalidArchive(_))
        ));
    }
}

#[test]
fn structural_path_and_symbolic_link_rejections_are_not_copy_errors() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut fixtures = [
        "../escape.apk",
        "/escape.apk",
        "a\\b.apk",
        "a:b.apk",
        "a\n.apk",
    ]
    .into_iter()
    .map(|name| stored_zip(&[(name, b"data")]).bytes)
    .collect::<Vec<_>>();
    let mut symlink = stored_zip(&[("link.apk", b"target")]);
    let attributes = symlink.members[0].central_header + 38;
    symlink.bytes[attributes..attributes + 4].copy_from_slice(&(0o120_777u32 << 16).to_le_bytes());
    fixtures.push(symlink.bytes);
    for bytes in fixtures {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("bad.zip");
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            Archive::open(
                File::open(path).unwrap(),
                ArchiveProfile::Structure,
                &control
            ),
            Err(Error::InvalidArchive(_))
        ));
    }
}

#[test]
fn cancellation_after_observed_output_does_not_grant_a_copy_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = vec![0x5a; 3 * 64 * 1024];
    let fixture = stored_zip(&[("large.apk", &payload)]);
    let never_cancelled = || false;
    let open_control = Control::new(None, &never_cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &open_control);
    let selected = archive.select_exact("large.apk", &open_control).unwrap();
    let output_path = temporary.path().join("output.apk");
    let mut output = new_output(&temporary);
    let cancelled = || fs::metadata(&output_path).unwrap().len() >= 64 * 1024;
    let copy_control = Control::new(None, &cancelled);
    assert!(matches!(
        selected.copy_to(
            &mut output,
            u64::try_from(payload.len()).unwrap(),
            &copy_control
        ),
        Err(Error::Cancelled)
    ));
    let written = fs::metadata(output_path).unwrap().len();
    assert!(written >= 64 * 1024);
    assert!(written <= u64::try_from(payload.len()).unwrap());
    // 只证明已观测写入后的合作停止，不定位严格返回前检查或物理零 I/O。
}

#[test]
fn read_only_destination_preserves_io_stage_and_underlying_error() {
    let temporary = tempfile::tempdir().unwrap();
    let fixture = stored_zip(&[("selected.apk", b"data")]);
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    let output_path = temporary.path().join("readonly.apk");
    fs::write(&output_path, b"").unwrap();
    let mut readonly = File::open(output_path).unwrap();
    let error = match archive
        .select_exact("selected.apk", &control)
        .unwrap()
        .copy_to(&mut readonly, 4, &control)
    {
        Err(error) => error,
        Ok(_) => panic!("只读目的句柄不能得到成功摘要"),
    };
    match error {
        Error::Io {
            stage: deviceforge_android_package_core::IoStage::Write,
            source,
        } => {
            assert!(source.raw_os_error().is_some());
        }
        other => panic!("预期保留写入 I/O 错误，实际：{other:?}"),
    }
}

#[test]
fn names_use_utf8_byte_limits_and_copy_keeps_binary_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let equal = format!("{}中.apk", "a".repeat(493));
    let over = format!("a{equal}");
    assert_eq!(equal.len(), 500);
    assert_eq!(over.len(), 501);
    let payload = b"\x00\xff binary\r\n\x80";
    let fixture = stored_zip(&[(&equal, payload), (&over, b"over")]);
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &fixture.bytes, &control);
    assert!(matches!(
        archive.select_exact(&over, &control),
        Err(Error::InvalidArgument(_))
    ));
    let result = archive
        .select_exact(&equal, &control)
        .unwrap()
        .copy_to(
            &mut new_output(&temporary),
            u64::try_from(payload.len()).unwrap(),
            &control,
        )
        .unwrap();
    assert_eq!(result.name, equal);
    assert_eq!(result.bytes, u64::try_from(payload.len()).unwrap());
    assert_eq!(
        fs::read(temporary.path().join("output.apk")).unwrap(),
        payload
    );
}

#[test]
fn structural_open_rejects_stored_length_mismatch_even_when_crc_bytes_are_unchanged() {
    let temporary = tempfile::tempdir().unwrap();
    let mut fixture = stored_zip(&[("selected.apk", b"123456789")]);
    let member = &fixture.members[0];
    // 两个 header 的展开长度一起改为八，压缩长度九和 payload/CRC 不变。
    fixture.bytes[member.local_header + 22..member.local_header + 26]
        .copy_from_slice(&8u32.to_le_bytes());
    fixture.bytes[member.central_header + 24..member.central_header + 28]
        .copy_from_slice(&8u32.to_le_bytes());
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let input = temporary.path().join("input.zip");
    fs::write(&input, &fixture.bytes).unwrap();
    assert!(matches!(
        Archive::open(
            File::open(input).unwrap(),
            ArchiveProfile::Structure,
            &control
        ),
        Err(Error::InvalidArchive("Stored 长度不一致"))
    ));
    assert!(!temporary.path().join("output.apk").exists());
}

#[test]
fn full_deflate_copy_rejects_declared_length_mismatch_after_structural_open() {
    let temporary = tempfile::tempdir().unwrap();
    let mut bytes = deflate_zip::fixture(deflate_zip::Case::Valid);
    // 固定原件包含完整十四字节 Deflate 流，实际展开九字节；只改声明为八。
    assert_eq!(bytes.len(), 128);
    assert_eq!(&bytes[38..52], deflate_zip::RAW_DEFLATE);
    assert_eq!(&bytes[52..56], b"PK\x01\x02");
    assert_eq!(&bytes[18..22], &14u32.to_le_bytes());
    assert_eq!(&bytes[72..76], &14u32.to_le_bytes());
    assert_eq!(&bytes[22..26], &9u32.to_le_bytes());
    assert_eq!(&bytes[76..80], &9u32.to_le_bytes());
    assert_eq!(&bytes[14..18], &deflate_zip::CHECKSUM.to_le_bytes());
    assert_eq!(&bytes[68..72], &deflate_zip::CHECKSUM.to_le_bytes());
    bytes[22..26].copy_from_slice(&8u32.to_le_bytes());
    bytes[76..80].copy_from_slice(&8u32.to_le_bytes());
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_archive(&temporary, &bytes, &control);
    assert_eq!(archive.directory().declared_size(), 8);
    let selected = archive.select_exact(deflate_zip::NAME, &control).unwrap();
    // 限额九允许真实正文；仅完整复制阶段判定声明矛盾，不接受其它错误或摘要。
    match selected.copy_to(&mut new_output(&temporary), 9, &control) {
        Err(Error::InvalidArchive(_)) => {}
        Err(error) => panic!("预期复制阶段的 InvalidArchive，实际：{error:?}"),
        Ok(summary) => panic!("展开长度不符不能返回成功摘要：{summary:?}"),
    }
}
