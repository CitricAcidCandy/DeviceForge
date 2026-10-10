use std::{fs::File, io::Write};

pub fn live() -> deviceforge_android_package_core::Control<'static> {
    deviceforge_android_package_core::Control::new(None, &never_cancelled)
}

fn never_cancelled() -> bool {
    false
}

// 测试自行生成最小 Stored 容器，能保留重名并独立篡改头部/CRC；不调用被测解析器。
pub fn stored(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    for (name, body, mode) in entries {
        let offset = bytes.len() as u32;
        let crc = crc32(body);
        bytes.extend_from_slice(b"PK\x03\x04");
        u16le(&mut bytes, 20);
        u16le(&mut bytes, 0x800);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u16le(&mut bytes, 0);
        u32le(&mut bytes, crc);
        u32le(&mut bytes, body.len() as u32);
        u32le(&mut bytes, body.len() as u32);
        u16le(&mut bytes, name.len() as u16);
        u16le(&mut bytes, 0);
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(body);
        directory.extend_from_slice(b"PK\x01\x02");
        u16le(&mut directory, 0x314);
        u16le(&mut directory, 20);
        u16le(&mut directory, 0x800);
        u16le(&mut directory, 0);
        u16le(&mut directory, 0);
        u16le(&mut directory, 0);
        u32le(&mut directory, crc);
        u32le(&mut directory, body.len() as u32);
        u32le(&mut directory, body.len() as u32);
        u16le(&mut directory, name.len() as u16);
        u16le(&mut directory, 0);
        u16le(&mut directory, 0);
        u16le(&mut directory, 0);
        u16le(&mut directory, 0);
        u32le(&mut directory, mode << 16);
        u32le(&mut directory, offset);
        directory.extend_from_slice(name.as_bytes());
    }
    let offset = bytes.len() as u32;
    let size = directory.len() as u32;
    bytes.extend(directory);
    bytes.extend_from_slice(b"PK\x05\x06");
    u16le(&mut bytes, 0);
    u16le(&mut bytes, 0);
    u16le(&mut bytes, entries.len() as u16);
    u16le(&mut bytes, entries.len() as u16);
    u32le(&mut bytes, size);
    u32le(&mut bytes, offset);
    u16le(&mut bytes, 0);
    bytes
}

fn u16le(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn u32le(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

pub fn input(bytes: &[u8]) -> File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    file
}
