// 独立 Stored ZIP 夹具按固定字段编码；不调用被测核心或 zip writer 生成期望。
#[derive(Debug)]
pub struct MemberSpan {
    pub name: String,
    pub local_header: usize,
    pub payload: usize,
    pub central_header: usize,
}

#[derive(Debug)]
pub struct StoredZip {
    pub bytes: Vec<u8>,
    pub members: Vec<MemberSpan>,
    pub directory_offset: usize,
    pub footer_offset: usize,
}

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 == 0 { 0 } else { 0xedb8_8320 };
        }
    }
    !crc
}

fn u16le(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn u32le(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub fn stored_zip(entries: &[(&str, &[u8])]) -> StoredZip {
    let mut bytes = Vec::new();
    let mut members = Vec::new();
    let mut directory = Vec::new();
    for (name, payload) in entries {
        let name_length = u16::try_from(name.len()).expect("夹具名称长度有界");
        let size = u32::try_from(payload.len()).expect("夹具数据长度有界");
        let offset = u32::try_from(bytes.len()).expect("夹具偏移有界");
        let checksum = crc32(payload);
        let local_header = bytes.len();
        bytes.extend_from_slice(b"PK\x03\x04");
        for value in [20, 0x0800, 0, 0, 0] {
            u16le(&mut bytes, value);
        }
        for value in [checksum, size, size] {
            u32le(&mut bytes, value);
        }
        u16le(&mut bytes, name_length);
        u16le(&mut bytes, 0);
        bytes.extend_from_slice(name.as_bytes());
        let payload_offset = bytes.len();
        bytes.extend_from_slice(payload);

        let central_header = directory.len();
        directory.extend_from_slice(b"PK\x01\x02");
        for value in [0x0314, 20, 0x0800, 0, 0, 0] {
            u16le(&mut directory, value);
        }
        for value in [checksum, size, size] {
            u32le(&mut directory, value);
        }
        for value in [name_length, 0, 0, 0, 0] {
            u16le(&mut directory, value);
        }
        let attributes = if name.ends_with('/') {
            (0o040_755 << 16) | 0x10
        } else {
            0o100_644 << 16
        };
        u32le(&mut directory, attributes);
        u32le(&mut directory, offset);
        directory.extend_from_slice(name.as_bytes());
        members.push(MemberSpan {
            name: (*name).into(),
            local_header,
            payload: payload_offset,
            central_header,
        });
    }
    let directory_offset = bytes.len();
    let directory_size = u32::try_from(directory.len()).expect("夹具目录大小有界");
    for member in &mut members {
        member.central_header += directory_offset;
    }
    bytes.extend_from_slice(&directory);
    let footer_offset = bytes.len();
    bytes.extend_from_slice(b"PK\x05\x06");
    let count = u16::try_from(entries.len()).expect("夹具成员数有界");
    for value in [0, 0, count, count] {
        u16le(&mut bytes, value);
    }
    u32le(&mut bytes, directory_size);
    u32le(
        &mut bytes,
        u32::try_from(directory_offset).expect("夹具目录偏移有界"),
    );
    u16le(&mut bytes, 0);
    StoredZip {
        bytes,
        members,
        directory_offset,
        footer_offset,
    }
}
