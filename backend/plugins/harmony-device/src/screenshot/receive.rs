use super::{
    jpeg,
    models::{FILE_LIMIT, FRAME_LIMIT, Frame},
    rules,
};
use crate::{Error, Result, session::files};
use deviceforge_data_codec::jpeg::{Info, Validator};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub(super) fn frame(path: &Path, token: &str, received: u64) -> Result<Frame> {
    let metadata = files::regular(path, false)?;
    if received != metadata.len() || received > FRAME_LIMIT {
        return Err(Error::Dependency("截图编码帧长度不一致"));
    }
    let mut input = File::open(path).map_err(|_| Error::Io("编码帧无法打开"))?;
    files::opened(path, &input, &metadata)?;
    let start = received.saturating_sub(128);
    input
        .seek(SeekFrom::Start(start))
        .map_err(|_| Error::Io("编码帧尾部无法定位"))?;
    let mut tail = Vec::with_capacity(128);
    (&mut input)
        .take(129)
        .read_to_end(&mut tail)
        .map_err(|_| Error::Io("编码帧尾部无法读取"))?;
    if tail.len() > 128 {
        return Err(Error::TooLarge);
    }
    let marker = b"\nDF_READ_DONE:";
    let mut positions = tail
        .windows(marker.len())
        .enumerate()
        .filter(|(_, bytes)| *bytes == marker);
    let (position, _) = positions
        .next()
        .ok_or(Error::Dependency("截图缺少完整终端回执"))?;
    if positions.next().is_some() {
        return Err(Error::Dependency("截图回执重复或不是终端帧"));
    }
    let footer = rules::utf8(&tail[position + 1..])?;
    let status = rules::status(rules::terminal(footer, "DF_READ_DONE", token)?)?;
    let mut body_bytes = start + position as u64;
    if position > 0 && tail[position - 1] == b'\r' {
        body_bytes -= 1;
    }
    if body_bytes > 0 {
        input
            .seek(SeekFrom::Start(body_bytes.saturating_sub(2)))
            .map_err(|_| Error::Io("编码正文尾部无法定位"))?;
        let mut ending = [0; 2];
        let length = usize::try_from(body_bytes.min(2)).map_err(|_| Error::TooLarge)?;
        input
            .read_exact(&mut ending[..length])
            .map_err(|_| Error::Io("编码正文尾部无法读取"))?;
        if length > 0 && ending[length - 1] == b'\n' {
            body_bytes -= if length == 2 && ending[0] == b'\r' {
                2
            } else {
                1
            };
        }
    }
    files::opened(path, &input, &metadata)?;
    Ok(Frame { body_bytes, status })
}

fn alphabet(byte: u8) -> Result<u8> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(Error::Invalid("截图Base64包含非规范字符或padding")),
    }
}

pub(super) fn diagnostics(
    input: &mut impl Read,
    body_bytes: u64,
    check: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let mut remaining = body_bytes;
    let mut buffer = [0; 8192];
    let mut overlap = Vec::with_capacity(32);
    while remaining != 0 {
        check()?;
        let requested =
            usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| Error::TooLarge)?;
        let count = input
            .read(&mut buffer[..requested])
            .map_err(|_| Error::Io("编码正文无法读取"))?;
        if count == 0 {
            return Err(Error::Invalid("截图Base64正文截断"));
        }
        remaining -= count as u64;
        let mut window = Vec::with_capacity(overlap.len() + count);
        window.extend_from_slice(&overlap);
        window.extend_from_slice(&buffer[..count]);
        if let Some(position) = window
            .iter()
            .position(|byte| !byte.is_ascii_alphanumeric() && !b"+/=".contains(byte))
        {
            crate::rules::text(&window[position.saturating_sub(16)..], b"")?;
        }
        overlap.clear();
        overlap.extend_from_slice(&window[window.len().saturating_sub(32)..]);
    }
    check()
}

pub(super) fn quartet(bytes: [u8; 4]) -> Result<([u8; 3], usize, bool)> {
    let first = alphabet(bytes[0])?;
    let second = alphabet(bytes[1])?;
    let mut output = [(first << 2) | (second >> 4), 0, 0];
    if bytes[2] == b'=' {
        if bytes[3] != b'=' || second & 15 != 0 {
            return Err(Error::Invalid("截图Base64尾部位或padding无效"));
        }
        return Ok((output, 1, true));
    }
    let third = alphabet(bytes[2])?;
    output[1] = (second << 4) | (third >> 2);
    if bytes[3] == b'=' {
        if third & 3 != 0 {
            return Err(Error::Invalid("截图Base64尾部位或padding无效"));
        }
        return Ok((output, 2, true));
    }
    output[2] = (third << 6) | alphabet(bytes[3])?;
    Ok((output, 3, false))
}

pub(super) fn decode(
    input: &mut impl Read,
    output: &mut impl Write,
    body_bytes: u64,
    expected: u64,
    check: &dyn Fn() -> Result<()>,
) -> Result<Info> {
    if expected == 0 || expected > FILE_LIMIT || body_bytes > 89_478_488 {
        return Err(Error::TooLarge);
    }
    let mut validator = Validator::new();
    let mut remaining = body_bytes;
    let mut input_buffer = [0; 8192];
    let mut output_buffer = Vec::with_capacity(65_536);
    let mut pending = [0; 4];
    let mut pending_count = 0usize;
    let mut decoded = 0u64;
    let mut padded = false;
    while remaining != 0 {
        check()?;
        let requested = usize::try_from(remaining.min(input_buffer.len() as u64))
            .map_err(|_| Error::TooLarge)?;
        let count = input
            .read(&mut input_buffer[..requested])
            .map_err(|_| Error::Io("编码正文无法读取"))?;
        if count == 0 {
            return Err(Error::Invalid("截图Base64正文截断"));
        }
        remaining -= count as u64;
        for &byte in &input_buffer[..count] {
            if padded {
                return Err(Error::Invalid("截图Base64包含padding后内容"));
            }
            pending[pending_count] = byte;
            pending_count += 1;
            if pending_count == 4 {
                let (bytes, length, ended) = quartet(pending)?;
                decoded = decoded
                    .checked_add(length as u64)
                    .filter(|size| *size <= FILE_LIMIT && *size <= expected)
                    .ok_or(Error::TooLarge)?;
                output_buffer.extend_from_slice(&bytes[..length]);
                padded = ended;
                pending_count = 0;
                if output_buffer.len() >= 65_533 {
                    check()?;
                    validator.push(&output_buffer).map_err(jpeg::error)?;
                    output
                        .write_all(&output_buffer)
                        .map_err(|_| Error::Io("私有JPEG无法写入"))?;
                    output_buffer.clear();
                }
            }
        }
    }
    check()?;
    if pending_count != 0 || decoded != expected {
        return Err(Error::Invalid("截图Base64长度或设备大小不一致"));
    }
    validator.push(&output_buffer).map_err(jpeg::error)?;
    output
        .write_all(&output_buffer)
        .map_err(|_| Error::Io("私有JPEG无法写入"))?;
    validator.finish().map_err(jpeg::error)
}
