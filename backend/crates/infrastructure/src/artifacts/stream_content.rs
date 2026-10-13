use apk_domain::{Error, Result};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

const TEXT_LIMIT: u64 = 64 * 1024 * 1024;
const VIDEO_LIMIT: u64 = 128 * 1024 * 1024;
const BUFFER_SIZE: usize = 64 * 1024;

pub(super) fn limit(media_type: &str) -> Option<u64> {
    match media_type {
        "application/octet-stream" | "text/javascript" | "text/plain" | "application/x-ndjson" => {
            Some(TEXT_LIMIT)
        }
        "video/mp4" => Some(VIDEO_LIMIT),
        _ => None,
    }
}

pub(super) fn validate(path: &Path, media_type: &str) -> Result<()> {
    let mut file = File::open(path).map_err(storage)?;
    let size = file.metadata().map_err(storage)?.len();
    if size > limit(media_type).ok_or_else(|| Error::Invalid("未知产物媒体类型".into()))? {
        return Err(Error::TooLarge);
    }
    match media_type {
        "application/octet-stream" if size == 0 => Err(Error::Invalid("BIN 产物不能为空".into())),
        "application/octet-stream" | "text/plain" => Ok(()),
        "text/javascript" if size == 0 => Err(Error::Invalid("JS 产物不能为空".into())),
        "text/javascript" => validate_script(file),
        "application/x-ndjson" => validate_jsonl(file),
        "video/mp4" => {
            let mut header = [0; 12];
            file.read_exact(&mut header).map_err(|error| {
                if error.kind() == std::io::ErrorKind::UnexpectedEof {
                    Error::Invalid("MP4 头部不完整".into())
                } else {
                    storage(error)
                }
            })?;
            if &header[4..8] != b"ftyp" || u32::from_be_bytes(header[..4].try_into().unwrap()) < 12
            {
                return Err(Error::Invalid("MP4 标识或首段声明大小无效".into()));
            }
            Ok(())
        }
        _ => Err(Error::Invalid("未知产物媒体类型".into())),
    }
}

fn storage(error: std::io::Error) -> Error {
    Error::Storage(error.to_string())
}

fn validate_script(mut file: File) -> Result<()> {
    let mut buffer = [0; BUFFER_SIZE + 3];
    let mut pending = 0;
    let mut total = 0u64;
    loop {
        let length = file
            .read(&mut buffer[pending..pending + BUFFER_SIZE])
            .map_err(storage)?;
        if length == 0 {
            return if pending == 0 {
                Ok(())
            } else {
                Err(Error::Invalid("JS 产物包含截断的 UTF-8 字符".into()))
            };
        }
        total += length as u64;
        if total > TEXT_LIMIT {
            return Err(Error::TooLarge);
        }
        let bytes = &buffer[..pending + length];
        if bytes.contains(&0) {
            return Err(Error::Invalid("JS 产物不能包含空字节".into()));
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => pending = 0,
            Err(error) if error.error_len().is_none() => {
                let start = error.valid_up_to();
                let end = bytes.len();
                buffer.copy_within(start..end, 0);
                pending = end - start;
            }
            Err(_) => return Err(Error::Invalid("JS 产物必须使用合法 UTF-8".into())),
        }
    }
}

fn validate_jsonl(file: File) -> Result<()> {
    let mut reader = BufReader::with_capacity(BUFFER_SIZE, file);
    let mut line = Vec::new();
    let mut total = 0u64;
    loop {
        let bytes = reader.fill_buf().map_err(storage)?;
        if bytes.is_empty() {
            if !line.is_empty() {
                validate_line(&line)?;
            }
            return Ok(());
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(bytes.len());
        let consumed = length + usize::from(newline.is_some());
        total += consumed as u64;
        if total > TEXT_LIMIT || line.len() + length > deviceforge_data_codec::MAX_BYTES {
            return Err(Error::TooLarge);
        }
        line.extend_from_slice(&bytes[..length]);
        reader.consume(consumed);
        if newline.is_some() {
            validate_line(&line)?;
            line.clear();
        }
    }
}

fn validate_line(bytes: &[u8]) -> Result<()> {
    if std::str::from_utf8(bytes).is_err() {
        return Err(Error::Invalid("JSONL 产物必须使用合法 UTF-8".into()));
    }
    deviceforge_data_codec::parse_json(bytes)
        .map(|_| ())
        .map_err(|error| match error {
            deviceforge_data_codec::Error::Limit => Error::TooLarge,
            _ => Error::Invalid("JSONL 产物包含无效 JSON 行".into()),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_output_files_reject_before_reading_or_parsing_content() {
        let directory = tempfile::tempdir().unwrap();
        for (media_type, size) in [
            ("application/octet-stream", 64 * 1024 * 1024 + 1),
            ("text/javascript", 64 * 1024 * 1024 + 1),
            ("text/plain", 64 * 1024 * 1024 + 1),
            ("application/x-ndjson", 64 * 1024 * 1024 + 1),
            ("video/mp4", 128 * 1024 * 1024 + 1),
        ] {
            let path = directory.path().join("output");
            let file = File::create(&path).unwrap();
            file.set_len(size).unwrap();
            drop(file);
            assert!(matches!(validate(&path, media_type), Err(Error::TooLarge)));
        }
    }
}
