use super::super::{jpeg, models, receive};
use super::{Cursor, JPEG, TOKEN};
use crate::{Error, Result};
use std::io::Read;

const ENCODED: &[u8] = b"/9j/wAALCAACAAMBAREA/9oACAEBAAA/ABL/ADT/2Q==";

struct Fragmented<'a> {
    bytes: &'a [u8],
    size: usize,
}

impl Read for Fragmented<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = buffer.len().min(self.size).min(self.bytes.len());
        buffer[..count].copy_from_slice(&self.bytes[..count]);
        self.bytes = &self.bytes[count..];
        Ok(count)
    }
}

fn decode(bytes: &[u8], body: u64, expected: u64) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    receive::decode(
        &mut Cursor::new(bytes),
        &mut output,
        body,
        expected,
        &|| Ok(()),
    )?;
    Ok(output)
}

#[test]
fn canonical_quartets_reject_invalid_alphabet_padding_and_nonzero_tail_bits() {
    assert_eq!(receive::quartet(*b"TQ==").unwrap(), ([b'M', 0, 0], 1, true));
    assert_eq!(
        receive::quartet(*b"TWE=").unwrap(),
        ([b'M', b'a', 0], 2, true)
    );
    assert_eq!(
        receive::quartet(*b"TWFu").unwrap(),
        ([b'M', b'a', b'n'], 3, false)
    );
    for bytes in [*b"TR==", *b"TWF=", *b"=Q==", *b"TQ=A", *b"TQ-_", *b"TQ\r\n"] {
        assert!(receive::quartet(bytes).is_err());
    }
}

#[test]
fn incremental_decode_uses_public_jpeg_validation_and_preserves_original_bytes() {
    for size in 1..=ENCODED.len() {
        let mut input = Fragmented {
            bytes: ENCODED,
            size,
        };
        let mut output = Vec::new();
        let info = receive::decode(
            &mut input,
            &mut output,
            ENCODED.len() as u64,
            JPEG.len() as u64,
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!((info.width, info.height), (3, 2));
        assert_eq!(output, JPEG);
    }
    assert_eq!(
        decode(ENCODED, ENCODED.len() as u64, JPEG.len() as u64).unwrap(),
        JPEG
    );
    assert!(matches!(
        jpeg::error(deviceforge_data_codec::jpeg::Error::Limit),
        Error::TooLarge
    ));
    assert_eq!(
        jpeg::error(deviceforge_data_codec::jpeg::Error::Invalid).to_string(),
        "输入无效：JPEG结构无效、截断或包含尾随内容"
    );
    assert_eq!(
        jpeg::error(deviceforge_data_codec::jpeg::Error::Unsupported).to_string(),
        "输入无效：JPEG不支持该编码结构"
    );
}

#[test]
fn decoder_rejects_truncation_extra_content_size_disagreement_and_limits_before_writing() {
    for bytes in [
        b"TQ==A".as_slice(),
        b"TQ==TQ==",
        b"TQ==\n",
        b"TQ== ",
        b"TQ=",
        b"TQ",
    ] {
        assert!(decode(bytes, bytes.len() as u64, 1).is_err());
    }
    assert_eq!(
        decode(b"TQ==", 8, 1).unwrap_err().to_string(),
        "输入无效：截图Base64正文截断"
    );
    assert_eq!(
        decode(ENCODED, ENCODED.len() as u64, JPEG.len() as u64 + 1)
            .unwrap_err()
            .to_string(),
        "输入无效：截图Base64长度或设备大小不一致"
    );
    for (body, expected) in [(4, 0), (4, models::FILE_LIMIT + 1), (89_478_489, 1)] {
        assert!(matches!(
            decode(b"TQ==", body, expected),
            Err(Error::TooLarge)
        ));
    }
    assert!(matches!(
        decode(ENCODED, ENCODED.len() as u64, 1),
        Err(Error::TooLarge)
    ));
    let mut output = Vec::new();
    let error = receive::decode(
        &mut Cursor::new(ENCODED),
        &mut output,
        ENCODED.len() as u64,
        JPEG.len() as u64,
        &|| Err(Error::Cancelled),
    )
    .unwrap_err();
    assert!(matches!(error, Error::Cancelled));
    assert!(output.is_empty());
}

#[test]
fn receive_frame_accepts_only_owned_terminal_receipt_and_one_optional_encoding_line_ending() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("frame.b64");
    for ending in ["", "\n", "\r\n"] {
        for separator in ["\n", "\r\n"] {
            let bytes = format!("TQ=={ending}{separator}DF_READ_DONE:{TOKEN}:0{separator}");
            std::fs::write(&path, &bytes).unwrap();
            let frame = receive::frame(&path, TOKEN, bytes.len() as u64).unwrap();
            assert_eq!((frame.body_bytes, frame.status), (4, 0));
        }
    }
    for bytes in [
        format!("TQ==\nDF_READ_DONE:{TOKEN}:0"),
        "TQ==\nDF_READ_DONE:wrong:0\n".to_owned(),
        format!("TQ==\nDF_READ_DONE:{TOKEN}:0\nDF_READ_DONE:{TOKEN}:0\n"),
        format!("TQ==\nDF_READ_DONE:{TOKEN}:0\nlater\n"),
    ] {
        std::fs::write(&path, &bytes).unwrap();
        assert!(receive::frame(&path, TOKEN, bytes.len() as u64).is_err());
    }
    let bytes = format!("TQ==\nDF_READ_DONE:{TOKEN}:1\n");
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(
        receive::frame(&path, TOKEN, bytes.len() as u64)
            .unwrap()
            .status,
        1
    );
    assert!(receive::frame(&path, TOKEN, bytes.len() as u64 + 1).is_err());
}

#[test]
fn stdout_failure_diagnostics_cross_chunks_without_treating_base64_words_as_diagnostics() {
    let valid = b"errorfailurefailedunablecannotofflinenodevices";
    receive::diagnostics(&mut Cursor::new(valid), valid.len() as u64, &|| Ok(())).unwrap();
    for position in [0, 8187, 8190, 8191, 8192] {
        let mut bytes = vec![b'A'; position];
        bytes.extend(b"[fAiL] independent screenshot failure\n");
        assert_eq!(
            receive::diagnostics(&mut Cursor::new(&bytes), bytes.len() as u64, &|| Ok(()))
                .unwrap_err()
                .to_string(),
            "工具依赖失败：HDC返回失败诊断"
        );
    }
    assert!(receive::diagnostics(&mut Cursor::new(b"AAAA"), 5, &|| Ok(())).is_err());
}
