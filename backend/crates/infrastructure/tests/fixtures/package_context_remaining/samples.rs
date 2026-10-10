use apk_domain::{reverse::SdkRule, splits::DeviceSpec};
use std::io::{Cursor, Write};
use zip::{ZipWriter, write::SimpleFileOptions};

pub const DECODED_FILES: &[(&str, &[u8])] = &[
    ("apktool.yml", b"version: 2.9.0\n"),
    (
        "AndroidManifest.xml",
        b"<manifest package='com.example.remaining'/>",
    ),
    ("res/raw/payload.bin", b"original resource\0\xff\x80"),
    (
        "smali/com/example/sdk/Entry.smali",
        b".class public Lcom/example/sdk/Entry;\n",
    ),
    (
        "smali_classes2/com/example/sdk/Entry$Inner.smali",
        b".class public Lcom/example/sdk/Entry$Inner;\n",
    ),
    (
        "smali/com/example/sdkneighbor/Noise.smali",
        b"prefix neighbor must not match\n",
    ),
];

/// 仅构造独立输入和固定工具输出；不调用被测核心计算期望。
pub fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .expect("独立固定成员");
        writer.write_all(bytes).expect("独立成员字节");
    }
    writer.finish().expect("独立 ZIP 收尾").into_inner()
}

pub fn apk() -> Vec<u8> {
    archive(&[
        ("AndroidManifest.xml", b"synthetic manifest\0\xff"),
        ("classes.dex", b"fixed dex bytes\0\x80"),
    ])
}

pub fn configuration_apk() -> Vec<u8> {
    archive(&[
        ("AndroidManifest.xml", b"synthetic configuration\0"),
        ("res/raw/config.bin", b"arm64 configuration\xff"),
    ])
}

pub fn apks(universal: bool) -> Vec<u8> {
    let base = apk();
    let configuration = configuration_apk();
    if universal {
        archive(&[("toc.pb", b"fixed toc"), ("universal.apk", &base)])
    } else {
        archive(&[
            ("toc.pb", b"fixed toc"),
            ("splits/base-master.apk", &base),
            ("splits/base-arm64.apk", &configuration),
        ])
    }
}

pub fn decoded() -> Vec<u8> {
    archive(DECODED_FILES)
}

pub fn spec() -> DeviceSpec {
    DeviceSpec {
        supported_abis: vec!["arm64-v8a".into()],
        supported_locales: vec!["zh".into(), "en".into()],
        screen_density: 420,
        sdk_version: 35,
    }
}

pub fn rules() -> Vec<SdkRule> {
    vec![
        SdkRule {
            name: "exact".into(),
            package_path: "com.example.sdk".into(),
            class_name: Some("Entry".into()),
        },
        SdkRule {
            name: "inner".into(),
            package_path: "com.example.sdk".into(),
            class_name: Some("Entry$Inner".into()),
        },
        SdkRule {
            name: "missing-class".into(),
            package_path: "com.example.sdk".into(),
            class_name: Some("Absent".into()),
        },
        SdkRule {
            name: "package-only".into(),
            package_path: "com.example.sdk".into(),
            class_name: None,
        },
        SdkRule {
            name: "boundary".into(),
            package_path: "com.example.sd".into(),
            class_name: None,
        },
    ]
}
