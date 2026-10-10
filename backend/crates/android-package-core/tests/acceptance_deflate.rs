#[path = "acceptance_support/deflate_zip.rs"]
mod deflate_zip;

use deflate_zip::{CHECKSUM, Case, NAME, PLAINTEXT, RAW_DEFLATE, fixture};
use deviceforge_android_package_core::{ArchiveProfile, Control, Error, archive::Archive};
use std::fs::{self, File, OpenOptions};

fn open_structural(temporary: &tempfile::TempDir, bytes: &[u8], control: &Control<'_>) -> Archive {
    let path = temporary.path().join("input.zip");
    fs::write(&path, bytes).unwrap();
    Archive::open(
        File::open(path).unwrap(),
        ArchiveProfile::Structure,
        control,
    )
    .expect("外层目录保持完整，负向条件只应在成员读取时触发")
}

fn new_output(temporary: &tempfile::TempDir) -> File {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary.path().join("output.bin"))
        .unwrap()
}

#[test]
fn hand_encoded_deflate_fixtures_have_fixed_independent_layout() {
    assert_eq!(RAW_DEFLATE, b"\x01\x09\x00\xf6\xff123456789");
    assert_eq!(PLAINTEXT, b"123456789");
    assert_eq!(CHECKSUM, 0xcbf4_3926);
    assert_eq!(NAME.as_bytes(), b"data.bin");
    for (case, compressed_size, central, footer, length, checksum) in [
        (
            Case::Valid,
            14u32,
            52usize,
            106usize,
            128usize,
            0xcbf4_3926u32,
        ),
        (Case::TruncatedStream, 10, 48, 102, 124, 0xcbf4_3926),
        (Case::WrongCrc, 14, 52, 106, 128, 0xcbf4_3927),
    ] {
        let bytes = fixture(case);
        assert_eq!(bytes.len(), length);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert_eq!(&bytes[8..10], &8u16.to_le_bytes());
        assert_eq!(&bytes[14..18], &checksum.to_le_bytes());
        assert_eq!(&bytes[18..22], &compressed_size.to_le_bytes());
        assert_eq!(&bytes[22..26], &9u32.to_le_bytes());
        assert_eq!(&bytes[26..30], &[8, 0, 0, 0]);
        assert_eq!(&bytes[30..38], b"data.bin");
        assert_eq!(
            &bytes[38..central],
            &RAW_DEFLATE[..usize::try_from(compressed_size).unwrap()],
        );
        assert_eq!(&bytes[central..central + 4], b"PK\x01\x02");
        assert_eq!(&bytes[central + 10..central + 12], &8u16.to_le_bytes());
        assert_eq!(&bytes[central + 16..central + 20], &checksum.to_le_bytes());
        assert_eq!(
            &bytes[central + 20..central + 24],
            &compressed_size.to_le_bytes()
        );
        assert_eq!(&bytes[central + 24..central + 28], &9u32.to_le_bytes());
        assert_eq!(&bytes[central + 42..central + 46], &0u32.to_le_bytes());
        assert_eq!(&bytes[central + 46..footer], b"data.bin");
        assert_eq!(&bytes[footer..footer + 4], b"PK\x05\x06");
        assert_eq!(&bytes[footer + 4..footer + 12], &[0, 0, 0, 0, 1, 0, 1, 0]);
        assert_eq!(&bytes[footer + 12..footer + 16], &54u32.to_le_bytes());
        assert_eq!(
            &bytes[footer + 16..footer + 20],
            &u32::try_from(central).unwrap().to_le_bytes()
        );
        assert_eq!(&bytes[footer + 20..], &[0, 0]);
    }

    // CRC 负向只改变两套 header 的校验值，不改变压缩流或目录范围。
    let valid = fixture(Case::Valid);
    let wrong_crc = fixture(Case::WrongCrc);
    let changed = valid
        .iter()
        .zip(&wrong_crc)
        .enumerate()
        .filter_map(|(index, (first, second))| (first != second).then_some(index))
        .collect::<Vec<_>>();
    assert_eq!(changed, [14, 68]);
}

#[test]
fn raw_deflate_member_copies_all_original_bytes_with_a_success_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_structural(&temporary, &fixture(Case::Valid), &control);
    let entries = archive.directory().entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, NAME);
    assert_eq!(entries[0].size, 9);
    assert_eq!(entries[0].compressed_size, 14);
    assert!(!entries[0].directory);
    assert_eq!(archive.directory().declared_size(), 9);

    let selected = archive.select_exact(NAME, &control).unwrap();
    let summary = selected
        .copy_to(&mut new_output(&temporary), 9, &control)
        .unwrap();
    assert_eq!(summary.name, NAME);
    assert_eq!(summary.bytes, 9);
    assert_eq!(
        fs::read(temporary.path().join("output.bin")).unwrap(),
        PLAINTEXT
    );
}

#[test]
fn truncated_raw_deflate_is_invalid_archive_and_never_returns_a_copy_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_structural(&temporary, &fixture(Case::TruncatedStream), &control);
    assert_eq!(archive.directory().entries()[0].compressed_size, 10);
    assert_eq!(archive.directory().entries()[0].size, 9);

    let selected = archive.select_exact(NAME, &control).unwrap();
    let result = selected.copy_to(&mut new_output(&temporary), 9, &control);
    assert!(
        matches!(result, Err(Error::InvalidArchive(_))),
        "实际：{result:?}"
    );
    // 半文件由调用方拥有；其长度不能被视为 CopiedEntry 或解压成功证据。
    assert!(
        fs::metadata(temporary.path().join("output.bin"))
            .unwrap()
            .len()
            <= 9
    );
}

#[test]
fn valid_deflate_with_wrong_crc_is_invalid_archive_and_never_returns_a_copy_summary() {
    let temporary = tempfile::tempdir().unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let mut archive = open_structural(&temporary, &fixture(Case::WrongCrc), &control);
    assert_eq!(archive.directory().entries()[0].compressed_size, 14);
    assert_eq!(archive.directory().entries()[0].size, 9);

    let selected = archive.select_exact(NAME, &control).unwrap();
    let result = selected.copy_to(&mut new_output(&temporary), 9, &control);
    assert!(
        matches!(result, Err(Error::InvalidArchive(_))),
        "实际：{result:?}"
    );
    assert!(
        fs::metadata(temporary.path().join("output.bin"))
            .unwrap()
            .len()
            <= 9
    );
}
