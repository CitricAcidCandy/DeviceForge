// 手工编码单成员 ZIP 与原始 Deflate，独立于核心、zip writer 和旧 Stored 夹具。
pub const NAME: &str = "data.bin";
pub const PLAINTEXT: &[u8; 9] = b"123456789";
pub const CHECKSUM: u32 = 0xcbf4_3926;
// BFINAL=1、BTYPE=00，随后对齐到字节的 LEN=9、NLEN=!9 和九字节正文。
pub const RAW_DEFLATE: &[u8; 14] = b"\x01\x09\x00\xf6\xff123456789";

#[derive(Clone, Copy)]
pub enum Case {
    Valid,
    TruncatedStream,
    WrongCrc,
}

fn u16le(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn u32le(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub fn fixture(case: Case) -> Vec<u8> {
    let compressed = match case {
        // 保留完整块头但仅五字节正文；压缩长度随实际截短，ZIP 目录仍完整。
        Case::TruncatedStream => &RAW_DEFLATE[..10],
        Case::Valid | Case::WrongCrc => RAW_DEFLATE.as_slice(),
    };
    let checksum = match case {
        // 只改两个 header 的 CRC，Deflate 本身和展开长度保持完全合法。
        Case::WrongCrc => CHECKSUM ^ 1,
        Case::Valid | Case::TruncatedStream => CHECKSUM,
    };
    let compressed_size = u32::try_from(compressed.len()).expect("固定压缩夹具长度有界");
    let expanded_size = u32::try_from(PLAINTEXT.len()).expect("固定展开夹具长度有界");
    let name_size = u16::try_from(NAME.len()).expect("固定夹具名称有界");
    let mut bytes = Vec::new();

    bytes.extend_from_slice(b"PK\x03\x04");
    // 版本、UTF-8 标记、压缩方法 8、时间、日期。
    for value in [20, 0x0800, 8, 0, 0] {
        u16le(&mut bytes, value);
    }
    for value in [checksum, compressed_size, expanded_size] {
        u32le(&mut bytes, value);
    }
    u16le(&mut bytes, name_size);
    u16le(&mut bytes, 0);
    bytes.extend_from_slice(NAME.as_bytes());
    bytes.extend_from_slice(compressed);

    let directory_offset = u32::try_from(bytes.len()).expect("固定目录偏移有界");
    bytes.extend_from_slice(b"PK\x01\x02");
    // Unix 创建版本、最低版本、UTF-8、Deflate、时间、日期。
    for value in [0x0314, 20, 0x0800, 8, 0, 0] {
        u16le(&mut bytes, value);
    }
    for value in [checksum, compressed_size, expanded_size] {
        u32le(&mut bytes, value);
    }
    for value in [name_size, 0, 0, 0, 0] {
        u16le(&mut bytes, value);
    }
    u32le(&mut bytes, 0o100_644 << 16);
    u32le(&mut bytes, 0);
    bytes.extend_from_slice(NAME.as_bytes());
    let directory_size = u32::try_from(bytes.len()).expect("固定归档长度有界") - directory_offset;

    bytes.extend_from_slice(b"PK\x05\x06");
    for value in [0, 0, 1, 1] {
        u16le(&mut bytes, value);
    }
    u32le(&mut bytes, directory_size);
    u32le(&mut bytes, directory_offset);
    u16le(&mut bytes, 0);
    bytes
}
