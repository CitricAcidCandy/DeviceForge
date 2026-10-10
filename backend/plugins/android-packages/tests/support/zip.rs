//! 固定 Stored ZIP 的独立构造和只读核字节，不调用被测公共核心。
use std::collections::BTreeMap;

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn u16le(output: &mut Vec<u8>, value: u16) {
    output.extend(value.to_le_bytes());
}
fn u32le(output: &mut Vec<u8>, value: u32) {
    output.extend(value.to_le_bytes());
}

pub fn stored(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut central = Vec::new();
    for &(name, body) in entries {
        let offset = u32::try_from(bytes.len()).unwrap();
        let size = u32::try_from(body.len()).unwrap();
        let length = u16::try_from(name.len()).unwrap();
        u32le(&mut bytes, 0x0403_4b50);
        for value in [20, 0x0800, 0, 0, 0x0021] {
            u16le(&mut bytes, value);
        }
        for value in [crc32(body), size, size] {
            u32le(&mut bytes, value);
        }
        u16le(&mut bytes, length);
        u16le(&mut bytes, 0);
        bytes.extend(name.as_bytes());
        bytes.extend(body);
        u32le(&mut central, 0x0201_4b50);
        for value in [0x0314, 20, 0x0800, 0, 0, 0x0021] {
            u16le(&mut central, value);
        }
        for value in [crc32(body), size, size] {
            u32le(&mut central, value);
        }
        for value in [length, 0, 0, 0, 0] {
            u16le(&mut central, value);
        }
        u32le(&mut central, 0o100644 << 16);
        u32le(&mut central, offset);
        central.extend(name.as_bytes());
    }
    let offset = u32::try_from(bytes.len()).unwrap();
    let length = u32::try_from(central.len()).unwrap();
    bytes.extend(central);
    u32le(&mut bytes, 0x0605_4b50);
    for value in [0, 0, entries.len() as u16, entries.len() as u16] {
        u16le(&mut bytes, value);
    }
    u32le(&mut bytes, length);
    u32le(&mut bytes, offset);
    u16le(&mut bytes, 0);
    bytes
}

fn at16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn at32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

pub fn unpack_stored(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    assert!(bytes.len() >= 22, "最终归档需要完整 EOCD");
    let footer = bytes.len() - 22;
    assert_eq!(at32(bytes, footer), 0x0605_4b50);
    assert_eq!(at16(bytes, footer + 20), 0);
    let count = usize::from(at16(bytes, footer + 10));
    let mut offset = at32(bytes, footer + 16) as usize;
    let mut result = BTreeMap::new();
    for _ in 0..count {
        assert_eq!(at32(bytes, offset), 0x0201_4b50);
        assert_eq!(at16(bytes, offset + 10), 0, "输出应采用冻结的 Stored 格式");
        let size = at32(bytes, offset + 24) as usize;
        assert_eq!(at32(bytes, offset + 20) as usize, size);
        let name_length = usize::from(at16(bytes, offset + 28));
        let extra_length = usize::from(at16(bytes, offset + 30));
        let comment_length = usize::from(at16(bytes, offset + 32));
        let local = at32(bytes, offset + 42) as usize;
        let name = std::str::from_utf8(&bytes[offset + 46..offset + 46 + name_length]).unwrap();
        assert_eq!(at32(bytes, local), 0x0403_4b50);
        assert_eq!(at16(bytes, local + 8), 0);
        let begin = local
            + 30
            + usize::from(at16(bytes, local + 26))
            + usize::from(at16(bytes, local + 28));
        let body = bytes[begin..begin + size].to_vec();
        assert_eq!(
            crc32(&body),
            at32(bytes, offset + 16),
            "最终成员 CRC 与原字节一致"
        );
        assert!(
            result.insert(name.to_owned(), body).is_none(),
            "最终输出没有重名成员"
        );
        offset += 46 + name_length + extra_length + comment_length;
    }
    assert_eq!(offset, footer, "中央目录无额外成员");
    result
}
