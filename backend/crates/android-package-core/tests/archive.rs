mod common;
use common::{input, live, stored};
use deviceforge_android_package_core::{
    ArchiveProfile, Control, Error, LimitKind, archive::Archive,
};
use std::{
    io::{Read, Seek, SeekFrom},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

#[test]
fn exact_selection_keeps_duplicate_observations_and_rejects_missing() {
    let mut archive = Archive::open(
        input(&stored(&[("base.apk", b"a", 0), ("base.apk", b"b", 0)])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    assert_eq!(archive.directory().entries().len(), 2);
    assert!(matches!(
        archive.select_exact("base.apk", &live()),
        Err(Error::EntryDuplicate)
    ));
    assert!(matches!(
        archive.select_exact("absent.apk", &live()),
        Err(Error::EntryMissing)
    ));
}

#[test]
fn unsafe_paths_links_and_unsupported_node_types_are_rejected() {
    for (name, mode) in [
        ("../escape", 0),
        ("C:/escape", 0),
        ("a\\b", 0),
        ("a/./b", 0),
        ("a\u{0085}b", 0),
        ("link", 0o120777),
        ("pipe", 0o010644),
    ] {
        assert!(matches!(
            Archive::open(
                input(&stored(&[(name, b"x", mode)])),
                ArchiveProfile::Structure,
                &live()
            ),
            Err(Error::InvalidArchive(_))
        ));
    }
}

#[test]
fn malformed_footer_multidisk_zip64_and_declared_entry_limit_fail() {
    let valid = stored(&[("base.apk", b"x", 0)]);
    let end = valid.len() - 22;
    for offset in [4, 12, 16] {
        let mut bad = valid.clone();
        bad[end + offset] = 0xff;
        assert!(matches!(
            Archive::open(input(&bad), ArchiveProfile::Structure, &live()),
            Err(Error::InvalidArchive(_))
        ));
    }
    let mut many = valid.clone();
    many[end + 8..end + 12].copy_from_slice(&[0x11, 0x27, 0x11, 0x27]);
    assert!(matches!(
        Archive::open(input(&many), ArchiveProfile::Structure, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::Entries,
            ..
        })
    ));
    let mut zip64 = valid.clone();
    zip64[end + 10..end + 12].fill(0xff);
    assert!(matches!(
        Archive::open(input(&zip64), ArchiveProfile::Structure, &live()),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn crc_corruption_is_not_a_completed_copy_and_valid_copy_is_exact() {
    let bytes = stored(&[("base.apk", b"payload", 0)]);
    let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
    let mut target = tempfile::tempfile().unwrap();
    let copied = archive
        .select_exact("base.apk", &live())
        .unwrap()
        .copy_to(&mut target, 64, &live())
        .unwrap();
    assert_eq!(copied.bytes, 7);
    target.seek(SeekFrom::Start(0)).unwrap();
    let mut actual = Vec::new();
    target.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, b"payload");
    let mut bad = bytes;
    bad[30 + "base.apk".len()] ^= 1;
    let mut archive = Archive::open(input(&bad), ArchiveProfile::Structure, &live()).unwrap();
    assert!(matches!(
        archive.select_exact("base.apk", &live()).unwrap().copy_to(
            &mut tempfile::tempfile().unwrap(),
            64,
            &live()
        ),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn expired_copy_preserves_empty_destination_and_mid_copy_cancellation_fails() {
    let bytes = stored(&[("base.apk", &vec![42; 200_000], 0)]);
    let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
    let mut target = tempfile::tempfile().unwrap();
    let expired = Control::new(Some(Instant::now() - Duration::from_secs(1)), &|| false);
    assert!(matches!(
        archive
            .select_exact("base.apk", &live())
            .unwrap()
            .copy_to(&mut target, 300_000, &expired),
        Err(Error::Timeout)
    ));
    assert_eq!(target.metadata().unwrap().len(), 0);
    let checks = AtomicUsize::new(0);
    let observe = || {
        checks.fetch_add(1, Ordering::Relaxed);
        false
    };
    archive
        .select_exact("base.apk", &live())
        .unwrap()
        .copy_to(
            &mut tempfile::tempfile().unwrap(),
            300_000,
            &Control::new(None, &observe),
        )
        .unwrap();
    let threshold = checks.load(Ordering::Relaxed) / 2;
    let checks = AtomicUsize::new(0);
    let cancel = || checks.fetch_add(1, Ordering::Relaxed) >= threshold;
    let control = Control::new(None, &cancel);
    assert!(matches!(
        archive
            .select_exact("base.apk", &live())
            .unwrap()
            .copy_to(&mut target, 300_000, &control),
        Err(Error::Cancelled)
    ));
    let partial_length = target.metadata().unwrap().len();
    assert!(partial_length > 0 && partial_length < 200_000);
}

#[test]
fn declared_and_actual_output_limits_do_not_accept_a_partial_file() {
    let mut archive = Archive::open(
        input(&stored(&[("base.apk", b"payload", 0)])),
        ArchiveProfile::Structure,
        &live(),
    )
    .unwrap();
    let mut target = tempfile::tempfile().unwrap();
    assert!(matches!(
        archive
            .select_exact("base.apk", &live())
            .unwrap()
            .copy_to(&mut target, 6, &live()),
        Err(Error::LimitExceeded {
            kind: LimitKind::FileBytes,
            limit: 6
        })
    ));
    assert_eq!(target.metadata().unwrap().len(), 0);
}

// 独立构造 Deflate 的末块 Stored 编码，不调用库的压缩器生成期待值。
fn deflated() -> Vec<u8> {
    let mut bytes = stored(&[("base.apk", b"payload", 0)]);
    let start = 30 + "base.apk".len();
    let old_directory = start + 7;
    let compressed = b"\x01\x07\x00\xf8\xffpayload";
    bytes.splice(start..old_directory, compressed.iter().copied());
    let directory = start + compressed.len();
    bytes[8..10].copy_from_slice(&8u16.to_le_bytes());
    bytes[18..22].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    bytes[directory + 10..directory + 12].copy_from_slice(&8u16.to_le_bytes());
    bytes[directory + 20..directory + 24].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    let end = bytes.len() - 22;
    bytes[end + 16..end + 20].copy_from_slice(&(directory as u32).to_le_bytes());
    bytes
}

#[test]
fn deflate_full_read_checks_actual_length_and_crc() {
    let bytes = deflated();
    let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
    let mut target = tempfile::tempfile().unwrap();
    assert_eq!(
        archive
            .select_exact("base.apk", &live())
            .unwrap()
            .copy_to(&mut target, 100, &live())
            .unwrap()
            .bytes,
        7
    );
    let mut bad = bytes;
    let directory = 30 + "base.apk".len() + 12;
    bad[22..26].copy_from_slice(&8u32.to_le_bytes());
    bad[directory + 24..directory + 28].copy_from_slice(&8u32.to_le_bytes());
    let mut archive = Archive::open(input(&bad), ArchiveProfile::Structure, &live()).unwrap();
    assert!(matches!(
        archive.select_exact("base.apk", &live()).unwrap().copy_to(
            &mut tempfile::tempfile().unwrap(),
            100,
            &live()
        ),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn signed_data_descriptor_is_checked_and_can_be_copied() {
    let mut bytes = stored(&[("base.apk", b"payload", 0)]);
    let old_directory = 30 + "base.apk".len() + 7;
    let mut descriptor = b"PK\x07\x08".to_vec();
    descriptor.extend_from_slice(&bytes[14..26]);
    bytes.splice(old_directory..old_directory, descriptor);
    let directory = old_directory + 16;
    bytes[6..8].copy_from_slice(&0x808u16.to_le_bytes());
    bytes[14..26].fill(0);
    bytes[directory + 8..directory + 10].copy_from_slice(&0x808u16.to_le_bytes());
    let end = bytes.len() - 22;
    bytes[end + 16..end + 20].copy_from_slice(&(directory as u32).to_le_bytes());
    let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
    assert_eq!(
        archive
            .select_exact("base.apk", &live())
            .unwrap()
            .copy_to(&mut tempfile::tempfile().unwrap(), 100, &live())
            .unwrap()
            .bytes,
        7
    );
    bytes[old_directory + 4] ^= 1;
    assert!(matches!(
        Archive::open(input(&bytes), ArchiveProfile::Structure, &live()),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn completion_check_can_cancel_after_all_bytes_were_written_without_returning_summary() {
    let bytes = stored(&[("base.apk", b"payload", 0)]);
    let mut archive = Archive::open(input(&bytes), ArchiveProfile::Structure, &live()).unwrap();
    let checks = AtomicUsize::new(0);
    let observe = || {
        checks.fetch_add(1, Ordering::Relaxed);
        false
    };
    archive
        .select_exact("base.apk", &live())
        .unwrap()
        .copy_to(
            &mut tempfile::tempfile().unwrap(),
            100,
            &Control::new(None, &observe),
        )
        .unwrap();
    let last = checks.load(Ordering::Relaxed) - 1;
    let checks = AtomicUsize::new(0);
    let cancel = || checks.fetch_add(1, Ordering::Relaxed) >= last;
    let mut target = tempfile::tempfile().unwrap();
    assert!(matches!(
        archive.select_exact("base.apk", &live()).unwrap().copy_to(
            &mut target,
            100,
            &Control::new(None, &cancel)
        ),
        Err(Error::Cancelled)
    ));
    assert_eq!(target.metadata().unwrap().len(), 7);
}
