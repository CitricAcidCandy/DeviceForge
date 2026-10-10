use std::io::{Cursor, Write};
use zip::{ZipWriter, write::SimpleFileOptions};

pub const ENTRY: &str = "splits/base-master.apk";
pub const MANIFEST: &str = "<manifest xmlns:a='http://schemas.android.com/apk/res/android' package='com.example.context' a:versionCode='42' a:versionName='1 &amp; 2'><uses-sdk a:minSdkVersion='23' a:targetSdkVersion='35'/><uses-permission a:name='android.permission.INTERNET'/><application a:label='@string/app_name' a:debuggable='false'/></manifest>";
pub const ENTITY_URI: &str = "<manifest xmlns:a='http://schemas.android.com/apk/res/andro&#105;d' package='com.example.context' a:versionName='entity'><application a:debuggable='true'/></manifest>";
pub const UNDEFINED_ENTITY: &str =
    "<manifest xmlns:a='&undeclared;' package='com.example.context' a:versionName='bad'/>";
pub const EQUIVALENT_DUPLICATE: &str = "<manifest xmlns:a='http://schemas.android.com/apk/res/andro&#105;d' xmlns:b='http://schemas.android.com/apk/res/android' package='com.example.context' a:versionName='first' b:versionName='second'/>";
pub const SIGNATURE: &str = "Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): false\nNumber of signers: 1\nSigner #1 certificate DN: CN=Package Context\nSigner #1 certificate SHA-256 digest: abababababababababababababababababababababababababababababababab\nWARNING: input @INPUT@ is a synthetic fixture\n";

/// 只生成输入；预期 DTO 和下载字节不调用核心实现求值。
pub fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .expect("独立输入成员");
        writer.write_all(bytes).expect("独立输入字节");
    }
    writer.finish().expect("独立输入 ZIP 收尾").into_inner()
}

pub fn apk() -> Vec<u8> {
    archive(&[
        ("AndroidManifest.xml", b"synthetic binary manifest\0\xff"),
        ("classes.dex", b"fixed bytes\0\x80"),
    ])
}

pub fn apks() -> Vec<u8> {
    archive(&[("toc.pb", b"synthetic toc"), (ENTRY, &apk())])
}
