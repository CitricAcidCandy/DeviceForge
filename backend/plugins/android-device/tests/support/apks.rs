//! 独立手工 Stored ZIP 与 APKS 授权；不调用生产归档或解析规则生成期望。
use super::{
    Fixture,
    artifacts::{ARTIFACT_ID, input_row},
    device,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

pub fn configure(fixture: &mut Fixture) -> PathBuf {
    let jar = fixture.root.join("独立 bundletool.jar");
    fs::write(&jar, "独立假Java只检查JAR路径，不执行JAR内容").unwrap();
    fixture.config["tools"]["java"] = json!(fixture.executable);
    fixture.config["tools"]["bundletool"] = json!({"kind":"java_jar","jar":jar});
    fixture.save_config();
    jar
}

pub fn request(fixture: &Fixture, bytes: &[u8]) -> Value {
    let source = fixture.root.join("authorized-source.apks");
    fs::write(&source, bytes).unwrap();
    let mut row = input_row(&source, bytes);
    row["filename"] = json!("独立 分包.APKS");
    let mut request = fixture.request(
        "app.install_apks",
        device(json!({"artifact_id":ARTIFACT_ID})),
    );
    request["artifacts"] = json!({"inputs":[row],"output_directory":null});
    request
}

pub fn sample() -> Vec<u8> {
    stored_zip(&[
        ("toc.pb", b"independent-toc"),
        ("splits/base.apk", b"PK\x03\x04independent-apk"),
    ])
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 == 0 { 0 } else { 0xedb8_8320 };
        }
    }
    !crc
}

pub fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    for (name, payload) in entries {
        let offset = u32::try_from(bytes.len()).unwrap();
        let size = u32::try_from(payload.len()).unwrap();
        let name_length = u16::try_from(name.len()).unwrap();
        let crc = crc32(payload);
        bytes.extend_from_slice(b"PK\x03\x04");
        for value in [20u16, 0x0800, 0, 0, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, size, size] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name_length, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(payload);
        directory.extend_from_slice(b"PK\x01\x02");
        for value in [0x0314u16, 20, 0x0800, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, size, size] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name_length, 0, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [0o100644u32 << 16, offset] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        directory.extend_from_slice(name.as_bytes());
    }
    let offset = u32::try_from(bytes.len()).unwrap();
    let size = u32::try_from(directory.len()).unwrap();
    bytes.extend_from_slice(&directory);
    bytes.extend_from_slice(b"PK\x05\x06");
    let count = u16::try_from(entries.len()).unwrap();
    for value in [0u16, 0, count, count] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&offset.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}
