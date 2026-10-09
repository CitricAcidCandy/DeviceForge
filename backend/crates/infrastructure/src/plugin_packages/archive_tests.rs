//! 归档扩展头与资源上限的真实压缩字节回归。
use super::archive;
use apk_domain::{Error, plugin_packages::PackageFormat};
use std::io::{Cursor, Write};

fn tgz(entries: &[(u8, &str, u64, Vec<u8>)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (kind, path, size, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::new(*kind));
        header.set_path(path).unwrap();
        header.set_size(*size);
        header.set_mode(0o644);
        header.set_cksum();
        tar.extend_from_slice(header.as_bytes());
        tar.extend_from_slice(bytes);
        tar.resize(tar.len().next_multiple_of(512), 0);
    }
    tar.resize(tar.len() + 1024, 0);
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&tar).unwrap();
    gzip.finish().unwrap()
}
fn extract(bytes: &[u8], format: PackageFormat) -> apk_domain::Result<tempfile::TempDir> {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input");
    let output = directory.path().join("output");
    std::fs::write(&input, bytes).unwrap();
    std::fs::create_dir(&output).unwrap();
    archive::extract(&input, &output, format)?;
    Ok(directory)
}

#[test]
fn bounded_gnu_and_pax_long_paths_extract_the_same_resource() {
    let path = format!("package/dist/{}/child.js", "a".repeat(110));
    let record = format!("path={path}\n");
    let mut length = record.len() + 2;
    loop {
        let next = record.len() + length.to_string().len() + 1;
        if next == length {
            break;
        }
        length = next;
    }
    for (kind, extension) in [
        (b'L', format!("{path}\0").into_bytes()),
        (b'x', format!("{length} {record}").into_bytes()),
    ] {
        let bytes = tgz(&[
            (kind, "extension", extension.len() as u64, extension),
            (b'0', "package/short.js", 4, b"code".to_vec()),
        ]);
        let directory = extract(&bytes, PackageFormat::Tgz).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("output").join(&path[8..])).unwrap(),
            b"code"
        );
        assert!(!directory.path().join("output/short.js").exists());
    }
}

#[test]
fn oversized_tar_declarations_and_corrupt_gzip_fail_before_publication() {
    for entry in [
        (b'0', "package/huge.js", 64 * 1024 * 1024 + 1, vec![]),
        (b'L', "extension", 4097, vec![]),
    ] {
        assert!(matches!(
            extract(&tgz(&[entry]), PackageFormat::Tgz),
            Err(Error::TooLarge)
        ));
    }
    let valid = tgz(&[(b'0', "package/main.js", 4, b"code".to_vec())]);
    let mut bad_crc = valid.clone();
    let checksum = bad_crc.len() - 8;
    bad_crc[checksum] ^= 1;
    let truncated = valid[..valid.len() - 8].to_vec();
    let orphan = tgz(&[(b'L', "extension", 16, b"package/main.js\0".to_vec())]);
    for bytes in [bad_crc, truncated, orphan] {
        assert!(matches!(
            extract(&bytes, PackageFormat::Tgz),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn zip_entry_count_is_rejected_before_creating_files() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..4097 {
        zip.start_file(
            format!("entry-{index}.js"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    assert!(matches!(
        extract(&bytes, PackageFormat::Zip),
        Err(Error::TooLarge)
    ));
}
